import SwiftUI

/// The fields of the bill form as `Form` sections: used by the "add bill" page and the edit sheet.
struct BillFormFields: View {
    @Binding var values: BillFormValues
    let accounts: [BillAccountOption]
    let errors: [String: String]
    /// The bill has payments, so its kind and currency cannot change any more.
    var locked = false

    var body: some View {
        Group {
            identitySection
            amountSection
            datesSection
            referenceSection
            moreSection
        }
    }

    private var identitySection: some View {
        Section {
            Picker("Type", selection: $values.kind) {
                Text("Invoice").tag("invoice")
                Text("Credit note").tag("credit_note")
            }
            .disabled(locked)
            FieldError(errors["kind"])
            TextField("Invoice number (optional)", text: $values.invoiceNumber)
                .autocorrectionDisabled()
            FieldError(errors["invoiceNumber"])
            TextField("Creditor name", text: $values.creditorName)
            FieldError(errors["creditorName"])
            TextField("Creditor IBAN (optional)", text: $values.creditorIban)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.body.monospaced())
            FieldError(errors["creditorIban"])
        } footer: {
            if locked { Text("Type and currency are locked: payments are already matched to this bill.") }
        }
    }

    private var amountSection: some View {
        Section {
            AmountField("Amount (optional)", text: $values.amount)
            FieldError(errors["amount"])
            HStack {
                Text("Currency")
                Spacer()
                TextField("CHF", text: $values.currency)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 80)
                    .disabled(locked)
            }
            FieldError(errors["currency"])
        } footer: {
            Text("Leave the amount empty for an open amount.")
        }
    }

    private var datesSection: some View {
        Section("Dates") {
            DateField("Issue date", value: $values.issueDate, optional: true)
            FieldError(errors["issueDate"])
            DateField("Due date", value: $values.dueDate, optional: true)
            FieldError(errors["dueDate"])
        }
    }

    private var referenceSection: some View {
        Section("Payment reference") {
            Picker("Reference type", selection: $values.referenceType) {
                Text(BillText.referenceTypeLabel("")).tag("")
                Text(BillText.referenceTypeLabel("QRR")).tag("QRR")
                Text(BillText.referenceTypeLabel("SCOR")).tag("SCOR")
                Text(BillText.referenceTypeLabel("NON")).tag("NON")
            }
            FieldError(errors["referenceType"])
            TextField("Reference (optional)", text: $values.reference)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.body.monospaced())
            FieldError(errors["reference"])
            TextField("Message (optional)", text: $values.message)
            FieldError(errors["message"])
        }
    }

    private var moreSection: some View {
        Section("More") {
            Picker("Expected paying account", selection: $values.expectedAccountId) {
                Text("None").tag("")
                ForEach(accounts) { account in
                    Text("\(account.name) (\(account.currency))").tag(account.id)
                }
            }
            FieldError(errors["expectedAccountId"])
            TextField("Tax year (optional)", text: $values.taxYear)
                .keyboardType(.numberPad)
            FieldError(errors["taxYear"])
            TextField("Notes (optional)", text: $values.notes, axis: .vertical)
                .lineLimit(2 ... 6)
            FieldError(errors["notes"])
        }
    }
}
