import SwiftUI

/// Adds a planned item or edits one: a one-off expected income or expense.
struct ForecastPlannedSheet: View {
    let store: PageStore<ForecastPage>
    let item: ForecastPage.Planned?
    let accounts: [ForecastPage.Account]

    @State private var label: String
    @State private var date: String
    @State private var direction: String
    @State private var accountId: String
    @State private var amount: String
    @State private var currency: String

    init(store: PageStore<ForecastPage>, item: ForecastPage.Planned?, today: String, accounts: [ForecastPage.Account]) {
        self.store = store
        self.item = item
        self.accounts = accounts
        var currencies: [String] = []
        for account in accounts where !currencies.contains(account.currency) {
            currencies.append(account.currency)
        }
        currencies.sort()
        _label = State(initialValue: item?.label ?? "")
        _date = State(initialValue: item?.date ?? today)
        _direction = State(initialValue: item.map { ForecastLogic.direction($0.amount) } ?? "expense")
        _accountId = State(initialValue: item?.accountId ?? "")
        _amount = State(initialValue: item.map { ForecastLogic.amountText($0.amount, $0.currency) } ?? "")
        _currency = State(initialValue: item?.currency ?? currencies.first ?? "")
    }

    var body: some View {
        FormSheet(
            item == nil ? "Add planned item" : "Edit planned item",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: item == nil ? "Add item" : "Save",
            onSubmit: { await save() },
            content: { fields }
        )
    }

    @ViewBuilder
    private var fields: some View {
        Section {
            TextField("Description", text: $label)
            FieldError(store.formErrors["label"])
            DateField("Date", value: $date)
            FieldError(store.formErrors["date"])
            Picker("Type", selection: $direction) {
                Text("Expense").tag("expense")
                Text("Income").tag("income")
            }
            FieldError(store.formErrors["direction"])
        } footer: {
            Text("A one-off expected income or expense, such as a salary or a tax installment. It is added to the forecast on its date.")
        }
        Section {
            Picker("Account", selection: $accountId) {
                Text("No account").tag("")
                ForEach(accounts) { account in
                    Text("\(account.name) (\(account.currency))").tag(account.accountId)
                }
            }
            FieldError(store.formErrors["accountId"])
            AmountField("Amount", text: $amount, currency: accountId.isEmpty ? nil : accountCurrency)
            FieldError(store.formErrors["amount"])
            if accountId.isEmpty {
                TextField("Currency", text: $currency)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["currency"])
            }
        }
    }

    private var accountCurrency: String {
        for account in accounts where account.accountId == accountId {
            return account.currency
        }
        return ""
    }

    private func save() async -> Bool {
        var form = FormFields()
        if let item { form.set("id", item.id) }
        form.set("label", label)
        form.set("date", date)
        form.set("direction", direction)
        form.set("amount", amount)
        form.set("accountId", accountId)
        if accountId.isEmpty {
            form.set("currency", currency.trimmingCharacters(in: .whitespaces).uppercased())
        }
        let action = item == nil ? "createPlanned" : "updatePlanned"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}

/// The low balance limit and default payment account of one account.
struct ForecastSettingsSheet: View {
    let store: PageStore<ForecastPage>
    let target: ForecastSettingsTarget

    @State private var threshold: String
    @State private var defaultPayment: Bool

    init(store: PageStore<ForecastPage>, target: ForecastSettingsTarget) {
        self.store = store
        self.target = target
        var start = ""
        if let value = target.threshold { start = Formats.amountInput(value, target.currency) }
        _threshold = State(initialValue: start)
        _defaultPayment = State(initialValue: target.defaultPayment)
    }

    var body: some View {
        FormSheet(
            "Forecast settings",
            busy: store.busy,
            error: store.formErrors["form"],
            onSubmit: { await save() },
            content: { fields }
        )
    }

    @ViewBuilder
    private var fields: some View {
        Section {
            AmountField("Warn below", text: $threshold, currency: target.currency)
            FieldError(store.formErrors["threshold"])
        } header: {
            Text(target.name)
        } footer: {
            Text("Choose when to warn about a low balance. Empty means zero.")
        }
        Section {
            Toggle("Default payment account for \(target.currency)", isOn: $defaultPayment)
            FieldError(store.formErrors["defaultPayment"])
        } footer: {
            Text("Bills and planned items without an account are projected here.")
        }
    }

    private func save() async -> Bool {
        var form = FormFields()
        form.set("accountId", target.id)
        form.set("threshold", threshold)
        form.check("defaultPayment", defaultPayment)
        let result = await store.submit("saveSettings", form: form)
        return result != nil
    }
}
