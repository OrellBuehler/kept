import SwiftUI

/// Add or edit a portfolio ("addPortfolio", "updatePortfolio").
struct AccountPortfolioSheet: View {
    let store: PageStore<AccountPage>
    let portfolio: AccountPage.Portfolio?
    let qrIban: Bool

    @State private var name: String
    @State private var strategy: String
    @State private var number: String
    @State private var reference: String
    @State private var openedOn: String
    @State private var sortOrder: String

    init(store: PageStore<AccountPage>, portfolio: AccountPage.Portfolio?, qrIban: Bool) {
        self.store = store
        self.portfolio = portfolio
        self.qrIban = qrIban
        _name = State(initialValue: portfolio?.name ?? "")
        _strategy = State(initialValue: portfolio?.strategy ?? "")
        _number = State(initialValue: portfolio?.number ?? "")
        var referenceText = ""
        if let stored = portfolio?.depositReference { referenceText = AccountsLogic.formatReference(stored) }
        _reference = State(initialValue: referenceText)
        _openedOn = State(initialValue: portfolio?.openedOn ?? "")
        var sortText = ""
        if let portfolio, portfolio.sortOrder != 0 { sortText = String(portfolio.sortOrder) }
        _sortOrder = State(initialValue: sortText)
    }

    var body: some View {
        FormSheet(
            portfolio == nil ? "Add portfolio" : "Edit portfolio",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: portfolio == nil ? "Add" : "Save",
            submitDisabled: name.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            await save()
        } content: {
            Section {
                TextField("Name", text: $name)
                FieldError(store.formErrors["name"])
                TextField("Strategy (optional)", text: $strategy)
                FieldError(store.formErrors["strategy"])
                TextField("Number (optional)", text: $number)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["number"])
            } footer: {
                Text("Each portfolio is its own pension relationship with its own payment reference. The number is the provider's portfolio or relationship number.")
            }
            Section {
                TextField(qrIban ? "Payment reference (QR reference)" : "Payment reference (optional)", text: $reference)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["depositReference"])
            } footer: {
                Text("Payments carrying this reference are detected as contributions. \(qrIban ? "27 digits" : "27 digits or RF...") Spaces are fine.")
            }
            Section {
                DateField("Opened on", value: $openedOn, optional: true)
                FieldError(store.formErrors["openedOn"])
                TextField("Sort order (optional)", text: $sortOrder)
                    .keyboardType(.numbersAndPunctuation)
                FieldError(store.formErrors["sortOrder"])
            } footer: {
                Text("Lower sort numbers come first.")
            }
        }
    }

    private func save() async -> Bool {
        var form = FormFields()
        if let portfolio { form.set("portfolioId", portfolio.id) }
        form.set("name", name)
        form.set("strategy", strategy)
        form.set("number", number)
        form.set("depositReference", reference)
        form.set("openedOn", openedOn)
        form.set("sortOrder", sortOrder)
        let action = portfolio == nil ? "addPortfolio" : "updatePortfolio"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}

/// Close a portfolio on a day, with the reason ("closePortfolio").
struct AccountPortfolioCloseSheet: View {
    let store: PageStore<AccountPage>
    let portfolio: AccountPage.Portfolio?

    @State private var closedOn = Formats.isoDate(Date())
    @State private var reason = "age"

    var body: some View {
        FormSheet(
            "Close \(portfolio?.name ?? "portfolio")",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: "Close",
            submitDisabled: portfolio == nil
        ) {
            await save()
        } content: {
            Section {
                DateField("Closed on", value: $closedOn)
                FieldError(store.formErrors["closedOn"])
                Picker("Reason", selection: $reason) {
                    ForEach(AccountsLogic.closeReasons, id: \.value) { entry in
                        Text(entry.label).tag(entry.value)
                    }
                }
                FieldError(store.formErrors["closeReason"])
            } footer: {
                Text("A withdrawal dissolves the whole portfolio. From the closing date on it no longer counts towards your balance. Enter its final value first if you want it kept in the history.")
            }
        }
    }

    private func save() async -> Bool {
        guard let portfolio else { return false }
        var form = FormFields()
        form.set("portfolioId", portfolio.id)
        form.set("closedOn", closedOn)
        form.set("closeReason", reason)
        let result = await store.submit("closePortfolio", form: form)
        return result != nil
    }
}

/// The current value of each open portfolio on a day ("setPortfolioValues"); blank skips a portfolio.
struct AccountPortfolioValuesSheet: View {
    let store: PageStore<AccountPage>
    let page: AccountPage

    @State private var date = Formats.isoDate(Date())
    @State private var note = ""
    @State private var amounts: [String: String]

    init(store: PageStore<AccountPage>, page: AccountPage) {
        self.store = store
        self.page = page
        var start: [String: String] = [:]
        for portfolio in page.portfolios where portfolio.closedOn == nil {
            if let value = portfolio.latestValue {
                start[portfolio.id] = Formats.amountInput(value, page.account.currency)
            }
        }
        _amounts = State(initialValue: start)
    }

    private var openPortfolios: [AccountPage.Portfolio] {
        return page.portfolios.filter { $0.closedOn == nil }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(
            get: { amounts[id] ?? "" },
            set: { amounts[id] = $0 }
        )
    }

    var body: some View {
        FormSheet("Update values", busy: store.busy, error: store.formErrors["form"]) {
            await save()
        } content: {
            Section {
                DateField("Date", value: $date)
                FieldError(store.formErrors["date"])
            } footer: {
                Text("Enter the current value of your portfolios as shown by your provider. Leave a portfolio blank to skip it.")
            }
            Section("Values") {
                ForEach(openPortfolios) { portfolio in
                    VStack(alignment: .leading, spacing: 2) {
                        AmountField(label(portfolio), text: binding(portfolio.id), currency: page.account.currency)
                        FieldError(store.formErrors["value:" + portfolio.id])
                    }
                }
            }
            Section {
                TextField("Note (optional)", text: $note)
                FieldError(store.formErrors["note"])
            }
        }
    }

    private func label(_ portfolio: AccountPage.Portfolio) -> String {
        if let strategy = portfolio.strategy, !strategy.isEmpty { return "\(portfolio.name) \u{00B7} \(strategy)" }
        return portfolio.name
    }

    private func save() async -> Bool {
        var form = FormFields()
        form.set("date", date)
        form.set("note", note)
        for portfolio in openPortfolios {
            form.set("value:" + portfolio.id, amounts[portfolio.id] ?? "")
        }
        let result = await store.submit("setPortfolioValues", form: form)
        return result != nil
    }
}

/// The value history of a portfolio, newest first, with delete.
struct AccountPortfolioHistorySheet: View {
    let store: PageStore<AccountPage>
    let page: AccountPage
    let portfolioId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.formats) private var formats
    @State private var deleting: AccountPage.PortfolioValue?
    @State private var confirmDelete = false

    private var portfolioName: String {
        return page.portfolios.first(where: { $0.id == portfolioId })?.name ?? "Portfolio"
    }

    private var values: [AccountPage.PortfolioValue] {
        let current = store.state.value ?? page
        return current.portfolioValues[portfolioId] ?? []
    }

    private var messageBinding: Binding<String?> {
        Binding(
            get: { store.message },
            set: { store.message = $0 }
        )
    }

    var body: some View {
        NavigationStack {
            List {
                if values.isEmpty {
                    Text("No values entered yet.").foregroundStyle(.secondary)
                }
                ForEach(values) { value in
                    ValueRow(formats.date(value.date), subtitle: value.note) {
                        AmountText(value.amount, page.account.currency)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            deleting = value
                            confirmDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle(portfolioName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Delete this value?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let deleting {
                        Task { await delete(deleting) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The value recorded on \(formats.date(deleting?.date)) will be removed.")
            }
        }
        .messageAlert(messageBinding)
    }

    private func delete(_ value: AccountPage.PortfolioValue) async {
        var form = FormFields()
        form.set("portfolioId", portfolioId)
        form.set("valueId", value.id)
        await store.submit("deletePortfolioValue", form: form, showRefusal: true)
    }
}
