import SwiftUI

/// The details of a tax year: adds a new year (`fixedYear == nil`) or saves those of an existing one.
struct TaxDetailsSheet<Page: Decodable & Sendable>: View {
    let store: PageStore<Page>
    let title: String
    let submitLabel: String
    let fixedYear: String?
    let action: String

    @State private var year: String
    @State private var authority: String
    @State private var currency: String
    @State private var assessedTotal: String
    @State private var notes: String

    init(
        store: PageStore<Page>,
        title: String,
        submitLabel: String,
        action: String,
        fixedYear: String?,
        initialYear: String,
        authority: String,
        currency: String,
        assessedTotal: String,
        notes: String
    ) {
        self.store = store
        self.title = title
        self.submitLabel = submitLabel
        self.action = action
        self.fixedYear = fixedYear
        _year = State(initialValue: initialYear)
        _authority = State(initialValue: authority)
        _currency = State(initialValue: currency)
        _assessedTotal = State(initialValue: assessedTotal)
        _notes = State(initialValue: notes)
    }

    var body: some View {
        FormSheet(
            title,
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: submitLabel,
            submitDisabled: currency.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            return await save()
        } content: {
            Section {
                if fixedYear == nil {
                    TextField("Tax year", text: $year)
                        .keyboardType(.numberPad)
                    FieldError(store.formErrors["year"])
                }
                TextField("Tax authority", text: $authority)
                FieldError(store.formErrors["authority"])
                TextField("Currency (e.g. CHF)", text: $currency)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["currency"])
                AmountField("Assessed total (optional)", text: $assessedTotal, currency: currency.uppercased())
                FieldError(store.formErrors["assessedTotal"])
                TextField("Notes (optional)", text: $notes, axis: .vertical)
                    .lineLimit(2 ... 5)
                FieldError(store.formErrors["notes"])
            } footer: {
                Text("The tax authority and, once you have it, the assessed total: what the final assessment says is owed for the year.")
            }
        }
    }

    private func save() async -> Bool {
        let form = TaxText.detailsForm(
            year: fixedYear ?? year.trimmingCharacters(in: .whitespaces),
            authority: authority,
            currency: currency,
            assessedTotal: assessedTotal,
            notes: notes
        )
        let result = await store.submit(action, form: form)
        return result != nil
    }
}

/// A line of the tax office's statement.
struct TaxCreditSheet: View {
    let store: PageStore<TaxYearPage>
    let currency: String

    @State private var date = Formats.isoDate(Date())
    @State private var amount = ""
    @State private var reference = ""
    @State private var descriptionText = ""

    init(store: PageStore<TaxYearPage>, currency: String) {
        self.store = store
        self.currency = currency
    }

    var body: some View {
        FormSheet(
            "Add a statement line",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: "Add",
            submitDisabled: amount.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            return await save()
        } content: {
            Section {
                DateField("Date", value: $date)
                FieldError(store.formErrors["bookingDate"])
                AmountField("Amount", text: $amount, currency: currency)
                FieldError(store.formErrors["amount"])
                TextField("Reference (optional)", text: $reference)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["reference"])
                TextField("Description (optional)", text: $descriptionText)
                FieldError(store.formErrors["description"])
            } footer: {
                Text("From the tax office's account statement. Use a minus sign for money they paid back to you.")
            }
        }
    }

    private func save() async -> Bool {
        let form = TaxText.creditForm(
            date: date,
            amount: amount,
            reference: reference,
            description: descriptionText
        )
        let result = await store.submit("addCredit", form: form)
        return result != nil
    }
}
