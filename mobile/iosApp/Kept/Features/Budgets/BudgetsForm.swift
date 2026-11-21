import SwiftUI

/// Adds a budget or edits one: category, currency and the monthly amount.
struct BudgetsFormSheet: View {
    let store: PageStore<BudgetsPage>
    let row: BudgetsPage.Row?
    let categories: [BudgetsPage.Category]

    @State private var categoryId: String
    @State private var currency: String
    @State private var amount: String

    init(
        store: PageStore<BudgetsPage>,
        row: BudgetsPage.Row?,
        rowCurrency: String,
        categories: [BudgetsPage.Category],
        currencies: [String],
        defaultCurrency: String
    ) {
        self.store = store
        self.row = row
        self.categories = categories
        let startCategory = row?.categoryId ?? categories.first?.id ?? ""
        let startCurrency = rowCurrency.isEmpty ? (currencies.first ?? defaultCurrency) : rowCurrency
        var startAmount = ""
        if let row { startAmount = Formats.amountInput(row.budget, startCurrency) }
        _categoryId = State(initialValue: startCategory)
        _currency = State(initialValue: startCurrency)
        _amount = State(initialValue: startAmount)
    }

    var body: some View {
        FormSheet(
            row == nil ? "Add budget" : "Edit budget",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: row == nil ? "Add budget" : "Save",
            onSubmit: { await save() },
            content: { fields }
        )
    }

    @ViewBuilder
    private var fields: some View {
        Section {
            Picker("Category", selection: $categoryId) {
                ForEach(categories) { category in
                    Text(BudgetsLogic.categoryLabel(category, in: categories)).tag(category.id)
                }
            }
            FieldError(store.formErrors["categoryId"])
            TextField("Currency", text: $currency)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["currency"])
            AmountField("Monthly amount", text: $amount, currency: currency.uppercased())
            FieldError(store.formErrors["amount"])
        } footer: {
            Text("A monthly spending limit for a category, in one currency. It includes the category's subcategories.")
        }
    }

    private func save() async -> Bool {
        var form = FormFields()
        if let row { form.set("id", row.budgetId) }
        form.set("categoryId", categoryId)
        form.set("currency", currency.trimmingCharacters(in: .whitespaces).uppercased())
        form.set("amount", amount)
        let action = row == nil ? "createBudget" : "updateBudget"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}
