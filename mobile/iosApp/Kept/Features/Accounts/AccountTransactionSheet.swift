import SwiftUI

/// One transaction: what the bank says about it, its category, tax tags, transfer link, and edit and delete.
struct AccountTransactionSheet: View {
    let store: PageStore<AccountPage>
    let transactionId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.formats) private var formats
    @Environment(\.session) private var session
    @Environment(Router.self) private var router
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var showIban = false

    static func deleteMessage(mirror: Bool) -> String {
        if mirror {
            return "Kept stops mirroring this transfer and removes the transaction, so the balance is recalculated. It is not created again."
        }
        return "This manual transaction will be removed and the balance recalculated."
    }

    private var messageBinding: Binding<String?> {
        Binding(
            get: { store.message },
            set: { store.message = $0 }
        )
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Transaction")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .messageAlert(messageBinding)
    }

    @ViewBuilder
    private var content: some View {
        if let page = store.state.value, let transaction = page.transaction(withId: transactionId) {
            detail(page, transaction)
        } else {
            ContentUnavailableView("Transaction not found", systemImage: "questionmark.circle")
        }
    }

    private func detail(_ page: AccountPage, _ transaction: AccountPage.Tx) -> some View {
        List {
            summary(page, transaction)
            details(transaction)
            categorySection(page, transaction)
            AccountYearSection(
                store: store,
                transactionId: transaction.id,
                title: "Tax payment for year",
                hint: "Counts this transaction as paid to the tax office. Leave empty if it is not a tax payment.",
                action: "setTaxYear",
                field: "taxYear",
                initial: transaction.taxYear
            )
            AccountYearSection(
                store: store,
                transactionId: transaction.id,
                title: "Deduct in year",
                hint: "Counts this transaction in the tax deductions of that year instead of its booking year. Leave empty to use the booking year. This is not a tax payment.",
                action: "setDeductionYear",
                field: "deductionYear",
                initial: transaction.deductionYear
            )
            AccountTransferSection(store: store, transaction: transaction, onOpenAccount: { accountId in
                dismiss()
                router.push(.account(accountId))
            })
            if transaction.source != "import" {
                deleteSection(transaction)
            }
        }
        .sheet(isPresented: $editing) {
            AccountTransactionFormSheet(store: store, account: page.account, transaction: transaction)
        }
        .confirmationDialog(
            transaction.source == "mirror" ? "Remove this mirror?" : "Delete this transaction?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button(transaction.source == "mirror" ? "Remove mirror" : "Delete", role: .destructive) {
                Task { await delete(transaction) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(Self.deleteMessage(mirror: transaction.source == "mirror"))
        }
    }

    // MARK: Sections

    private func summary(_ page: AccountPage, _ transaction: AccountPage.Tx) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(formats.date(transaction.bookingDate)).font(.subheadline).foregroundStyle(.secondary)
                AmountText(transaction.amount, transaction.currency, tone: .signed, showPlus: true)
                    .font(.largeTitle.weight(.semibold))
                HStack(spacing: 4) {
                    Pill(AccountsLogic.sourceLabel(transaction.source))
                    if transaction.reversal { Pill("reversal") }
                }
                if let mirror = transaction.mirrorOf {
                    Text("Created from a transfer in \(mirror.accountName)").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            links(page.transactionLinks[transaction.id] ?? [])
        }
    }

    @ViewBuilder
    private func links(_ links: [AccountPage.ExternalLink]) -> some View {
        ForEach(links) { link in
            if let url = URL(string: link.url), url.scheme == "https" || url.scheme == "http" {
                Link(destination: url) {
                    Label(link.label, systemImage: "arrow.up.right.square")
                }
            }
        }
    }

    private func details(_ transaction: AccountPage.Tx) -> some View {
        Section {
            if let valueDate = transaction.valueDate {
                LabeledContent("Value date", value: formats.date(valueDate))
            }
            if let name = transaction.counterpartyName, !name.isEmpty {
                LabeledContent("Counterparty") { Text(name).multilineTextAlignment(.trailing) }
            }
            ibanRow(transaction)
            if let description = transaction.description, !description.isEmpty {
                LabeledContent("Description") { Text(description).multilineTextAlignment(.trailing) }
            }
            referenceRow(transaction)
            if let original = transaction.originalAmount, let currency = transaction.originalCurrency {
                LabeledContent("Original") { AmountText(original, currency) }
            }
            if let note = transaction.note, !note.isEmpty {
                LabeledContent("Note") { Text(note).multilineTextAlignment(.trailing) }
            }
            Button(AccountsLogic.isLocked(transaction) ? "Edit note" : "Edit transaction") { editing = true }
        } footer: {
            if transaction.source == "import" {
                Text("Imported transactions can only have their note changed. Delete the import to remove them.")
            } else if transaction.source == "mirror" {
                Text("Kept created this transaction from a transfer. Only the note can be changed. It follows the source and is replaced when you import a statement that contains it.")
            }
        }
    }

    @ViewBuilder
    private func ibanRow(_ transaction: AccountPage.Tx) -> some View {
        let mode = session?.preferences.ibanDisplay ?? "full"
        if let iban = transaction.counterpartyIban, mode != "hidden" {
            let text = showIban ? AccountsLogic.formatIban(iban) : (AccountsLogic.displayIban(iban, mode: mode) ?? "")
            LabeledContent("IBAN") {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(text).font(.system(.footnote, design: .monospaced)).multilineTextAlignment(.trailing)
                    if mode == "masked" {
                        Button(showIban ? "Hide" : "Show") { showIban.toggle() }
                            .font(.caption)
                            .buttonStyle(.borderless)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func referenceRow(_ transaction: AccountPage.Tx) -> some View {
        if let reference = transaction.reference, !reference.isEmpty {
            let kind = transaction.referenceType.map { " (\($0))" } ?? ""
            LabeledContent("Reference") {
                Text("\(reference)\(kind)").font(.system(.footnote, design: .monospaced)).multilineTextAlignment(.trailing)
            }
        }
    }

    private func categorySection(_ page: AccountPage, _ transaction: AccountPage.Tx) -> some View {
        Section {
            AccountCategoryPicker(categories: page.categories, selection: transaction.categoryId) { category in
                Task { await setCategory(transaction, category) }
            }
        }
    }

    private func deleteSection(_ transaction: AccountPage.Tx) -> some View {
        Section {
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Label(transaction.source == "mirror" ? "Remove mirror" : "Delete transaction", systemImage: "trash")
            }
        }
    }

    // MARK: Actions

    private func setCategory(_ transaction: AccountPage.Tx, _ category: String?) async {
        var form = FormFields()
        form.set("transactionId", transaction.id)
        form.set("categoryId", category ?? "")
        await store.submit("setCategory", form: form, showRefusal: true)
    }

    private func delete(_ transaction: AccountPage.Tx) async {
        var form = FormFields()
        form.set("transactionId", transaction.id)
        let result = await store.submit("deleteTransaction", form: form, showRefusal: true)
        if result != nil { dismiss() }
    }
}

/// The year a transaction counts for: a tax payment ("taxYear") or a deduction ("deductionYear"). Empty clears it.
struct AccountYearSection: View {
    let store: PageStore<AccountPage>
    let transactionId: String
    let title: String
    let hint: String
    let action: String
    let field: String

    @State private var text: String

    init(
        store: PageStore<AccountPage>,
        transactionId: String,
        title: String,
        hint: String,
        action: String,
        field: String,
        initial: Int?
    ) {
        self.store = store
        self.transactionId = transactionId
        self.title = title
        self.hint = hint
        self.action = action
        self.field = field
        var start = ""
        if let initial { start = String(initial) }
        _text = State(initialValue: start)
    }

    var body: some View {
        Section {
            TextField(title, text: $text)
                .keyboardType(.numberPad)
            FieldError(store.formErrors[field])
            Button("Save") {
                Task { await save() }
            }
            .disabled(store.busy)
        } header: {
            Text(title)
        } footer: {
            Text(hint)
        }
    }

    private func save() async {
        var form = FormFields()
        form.set("transactionId", transactionId)
        form.set(field, text.trimmingCharacters(in: .whitespaces))
        await store.submit(action, form: form)
    }
}

/// Add a manual transaction, or edit one (a full edit for manual rows, the note only for imported and mirrored rows).
struct AccountTransactionFormSheet: View {
    let store: PageStore<AccountPage>
    let account: AccountPage.Account
    let transaction: AccountPage.Tx?

    @State private var outgoing: Bool
    @State private var amount: String
    @State private var bookingDate: String
    @State private var valueDate: String
    @State private var counterpartyName: String
    @State private var counterpartyIban: String
    @State private var description: String
    @State private var reference: String
    @State private var note: String

    init(store: PageStore<AccountPage>, account: AccountPage.Account, transaction: AccountPage.Tx?) {
        self.store = store
        self.account = account
        self.transaction = transaction
        _outgoing = State(initialValue: (transaction?.amount ?? -1) < 0)
        var amountText = ""
        if let transaction { amountText = Formats.amountInput(Int64(transaction.amount.magnitude), account.currency) }
        _amount = State(initialValue: amountText)
        _bookingDate = State(initialValue: transaction?.bookingDate ?? Formats.isoDate(Date()))
        _valueDate = State(initialValue: transaction?.valueDate ?? "")
        _counterpartyName = State(initialValue: transaction?.counterpartyName ?? "")
        _counterpartyIban = State(initialValue: transaction?.counterpartyIban ?? "")
        _description = State(initialValue: transaction?.description ?? "")
        _reference = State(initialValue: transaction?.reference ?? "")
        _note = State(initialValue: transaction?.note ?? "")
    }

    private var noteOnly: Bool {
        guard let transaction else { return false }
        return AccountsLogic.isLocked(transaction)
    }

    var body: some View {
        FormSheet(
            transaction == nil ? "Add transaction" : (noteOnly ? "Edit note" : "Edit transaction"),
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: transaction == nil ? "Add" : "Save"
        ) {
            await save()
        } content: {
            if !noteOnly { fields }
            Section("Note") {
                TextField("Note (optional)", text: $note, axis: .vertical).lineLimit(1 ... 5)
                FieldError(store.formErrors["note"])
            }
        }
    }

    @ViewBuilder
    private var fields: some View {
        Section {
            DateField("Booking date", value: $bookingDate)
            FieldError(store.formErrors["bookingDate"])
            DateField("Value date", value: $valueDate, optional: true)
            FieldError(store.formErrors["valueDate"])
            Picker("Direction", selection: $outgoing) {
                Text("Out").tag(true)
                Text("In").tag(false)
            }
            .pickerStyle(.segmented)
            AmountField("Amount", text: $amount, currency: account.currency)
            FieldError(store.formErrors["amount"])
        } footer: {
            Text("Recorded by hand, in \(account.currency).")
        }
        Section {
            TextField("Counterparty (optional)", text: $counterpartyName)
            FieldError(store.formErrors["counterpartyName"])
            TextField("Counterparty IBAN (optional)", text: $counterpartyIban)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["counterpartyIban"])
            TextField("Description (optional)", text: $description)
            FieldError(store.formErrors["description"])
            TextField("Reference (optional)", text: $reference)
                .autocorrectionDisabled()
            FieldError(store.formErrors["reference"])
        }
    }

    /// The amount as the server parses it: the sign of the direction in front of what was typed.
    private func signedAmount() -> String {
        var text = amount.trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return "" }
        if text.hasPrefix("-") {
            return text
        }
        if text.hasPrefix("+") {
            text.removeFirst()
            return text
        }
        return outgoing ? "-" + text : text
    }

    private func save() async -> Bool {
        var form = FormFields()
        if let transaction { form.set("transactionId", transaction.id) }
        if !noteOnly {
            form.set("bookingDate", bookingDate)
            form.set("valueDate", valueDate)
            form.set("amount", signedAmount())
            form.set("counterpartyName", counterpartyName)
            form.set("counterpartyIban", counterpartyIban)
            form.set("description", description)
            form.set("reference", reference)
        }
        form.set("note", note)
        let action = transaction == nil ? "addTransaction" : "updateTransaction"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}
