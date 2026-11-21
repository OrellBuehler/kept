import SwiftUI

/// Maps the columns of a CSV or Excel file to a transaction and saves the mapping for the account.
struct ImportMappingView: View {
    let pendingId: String

    @State private var store: PageStore<ImportMappingPage>

    init(pendingId: String) {
        self.pendingId = pendingId
        _store = State(initialValue: PageStore<ImportMappingPage>(path: "import/\(pendingId)/mapping"))
    }

    var body: some View {
        PageView("Map columns", store: store) { page in
            ImportMappingEditor(page: page, store: store)
        }
    }
}

struct ImportMappingEditor: View {
    let page: ImportMappingPage
    let store: PageStore<ImportMappingPage>

    @State private var model: ImportMappingModel

    init(page: ImportMappingPage, store: PageStore<ImportMappingPage>) {
        self.page = page
        self.store = store
        _model = State(initialValue: ImportMappingModel(page: page))
    }

    var body: some View {
        Form {
            ImportMappingIntroSection(page: page, model: model)
            ImportMappingNameSection(model: model, store: store)
            if let profiles = page.otherProfiles, !profiles.isEmpty {
                ImportMappingCopySection(model: model, profiles: profiles)
            }
            ImportMappingLayoutSection(model: model, isXlsx: page.format == "xlsx")
            ImportMappingNumbersSection(model: model, accountCurrency: page.account.currency)
            ImportMappingAmountSection(model: model)
            ImportMappingColumnsSection(model: model)
            ImportMappingPreviewSection(model: model)
            ImportMappingSampleSection(model: model)
        }
        .onChange(of: model.form) { _, _ in
            model.formChanged()
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if store.busy {
                    ProgressView()
                } else {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(!model.canSave)
                }
            }
        }
    }

    private func save() async {
        var form = FormFields()
        form.set("name", model.name.trimmingCharacters(in: .whitespaces))
        form.set("profile", model.form.profileJSON())
        await store.submit("save", form: form, reload: false)
    }
}

// MARK: Sections

struct ImportMappingIntroSection: View {
    let page: ImportMappingPage
    let model: ImportMappingModel

    private var summary: String {
        let rows = ImportText.plural(model.dataRowCount, "row")
        return "\(page.fileName) · \(page.account.name) (\(page.account.currency)) · \(rows). The mapping is saved for this account and reused for future files."
    }

    var body: some View {
        Section {
            Text(summary).font(.footnote).foregroundStyle(.secondary)
        } header: {
            Text(ImportText.formatLabel(page.format))
        }
    }
}

struct ImportMappingNameSection: View {
    @Bindable var model: ImportMappingModel
    let store: PageStore<ImportMappingPage>

    var body: some View {
        Section("Profile name") {
            TextField("Name", text: $model.name)
            FieldError(store.formErrors["name"])
            FieldError(store.formErrors["profile"])
            FieldError(store.formErrors["form"])
        }
    }
}

struct ImportMappingCopySection: View {
    let model: ImportMappingModel
    let profiles: [ImportMappingPage.OtherProfile]

    var body: some View {
        Section {
            Menu {
                ForEach(profiles) { profile in
                    Button("\(profile.name) (\(profile.accountName))") {
                        model.apply(profile: profile)
                    }
                }
            } label: {
                Label("Copy another account's mapping", systemImage: "doc.on.doc")
            }
        } footer: {
            Text("For example one at the same bank. Changes here only affect this account.")
        }
    }
}

struct ImportMappingLayoutSection: View {
    @Bindable var model: ImportMappingModel
    let isXlsx: Bool

    var body: some View {
        Section {
            if !isXlsx {
                Picker("Delimiter", selection: $model.form.delimiter) {
                    ForEach(ImportMappingOptions.delimiters) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                Picker("Encoding", selection: $model.form.encoding) {
                    ForEach(ImportMappingOptions.encodings) { option in
                        Text(option.label).tag(option.value)
                    }
                }
            }
            LabeledContent("Header row") {
                TextField("1", text: $model.form.headerRow)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
            }
            if model.form.headerRowValue == nil {
                FieldError("Enter a whole number, 0 or more.")
            }
            LabeledContent("Footer rows to skip") {
                TextField("0", text: $model.form.skipFooterRows)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
            }
            if model.form.footerRowsValue == nil {
                FieldError("Enter a whole number, 0 or more.")
            }
        } header: {
            Text("File layout")
        } footer: {
            Text("The header row is the line number of the column names; 0 means no header, the columns are then numbered. Footer rows are trailing lines such as totals.")
        }
    }
}

struct ImportMappingNumbersSection: View {
    @Bindable var model: ImportMappingModel
    let accountCurrency: String

    var body: some View {
        Section {
            Picker("Date format", selection: $model.form.dateFormat) {
                ForEach(ImportMappingOptions.dateFormats) { option in
                    Text(option.label).tag(option.value)
                }
            }
            Picker("Decimal separator", selection: $model.form.decimalSeparator) {
                ForEach(ImportMappingOptions.decimals) { option in
                    Text(option.label).tag(option.value)
                }
            }
            Picker("Thousands separator", selection: $model.form.thousandsSeparator) {
                ForEach(ImportMappingOptions.thousands) { option in
                    Text(option.label).tag(option.value)
                }
            }
            LabeledContent("Default currency") {
                TextField(accountCurrency, text: $model.form.defaultCurrency)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .multilineTextAlignment(.trailing)
            }
        } header: {
            Text("Dates, numbers, currency")
        } footer: {
            Text("The default currency is used when there is no currency column or the cell is empty.")
        }
    }
}

struct ImportMappingAmountSection: View {
    @Bindable var model: ImportMappingModel

    private var keys: [String] {
        ImportMappingForm.amountKeys(for: model.form.amountMode)
    }

    var body: some View {
        Section("Amount") {
            Picker("Amount layout", selection: $model.form.amountMode) {
                ForEach(ImportMappingOptions.amountModes) { option in
                    Text(option.label).tag(option.value)
                }
            }
            if keys.contains("amount") {
                ImportColumnPicker(
                    "Amount column",
                    selection: columnBinding("amount"),
                    detected: model.detected,
                    byIndex: model.byIndex,
                    isRequired: true
                )
            }
            if keys.contains("indicator") {
                ImportColumnPicker(
                    "Credit/debit column",
                    selection: columnBinding("indicator"),
                    detected: model.detected,
                    byIndex: model.byIndex,
                    isRequired: true
                )
                LabeledContent("Values meaning credit") {
                    TextField("CRDT, Credit", text: $model.form.creditValues)
                        .autocorrectionDisabled()
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Values meaning debit") {
                    TextField("DBIT, Debit", text: $model.form.debitValues)
                        .autocorrectionDisabled()
                        .multilineTextAlignment(.trailing)
                }
            }
            if keys.contains("credit") {
                ImportColumnPicker(
                    "Credit column",
                    selection: columnBinding("credit"),
                    detected: model.detected,
                    byIndex: model.byIndex,
                    isRequired: false
                )
                ImportColumnPicker(
                    "Debit column",
                    selection: columnBinding("debit"),
                    detected: model.detected,
                    byIndex: model.byIndex,
                    isRequired: false
                )
            }
            Toggle("Invert sign (debits are positive in the file)", isOn: $model.form.invertSign)
        }
    }

    private func columnBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { model.form.columns[key] ?? "" },
            set: { model.form.columns[key] = $0 }
        )
    }
}

struct ImportMappingColumnsSection: View {
    @Bindable var model: ImportMappingModel

    private static let fields: [ImportMappingOption] = [
        ImportMappingOption(value: "bookingDate", label: "Booking date"),
        ImportMappingOption(value: "valueDate", label: "Value date"),
        ImportMappingOption(value: "currency", label: "Currency"),
        ImportMappingOption(value: "counterpartyName", label: "Counterparty name"),
        ImportMappingOption(value: "counterpartyIban", label: "Counterparty IBAN"),
        ImportMappingOption(value: "reference", label: "Payment reference"),
        ImportMappingOption(value: "externalId", label: "Bank reference (unique id)"),
        ImportMappingOption(value: "balance", label: "Balance after booking"),
    ]

    var body: some View {
        Section("Columns") {
            ForEach(Self.fields) { field in
                ImportColumnPicker(
                    field.label,
                    selection: columnBinding(field.value),
                    detected: model.detected,
                    byIndex: model.byIndex,
                    isRequired: field.value == "bookingDate"
                )
            }
            DisclosureGroup("Description (\(model.form.descriptionColumns.count))") {
                if model.detected.isEmpty {
                    Text("No columns detected.").foregroundStyle(.secondary)
                }
                ForEach(model.detected) { column in
                    Toggle(columnLabel(column), isOn: descriptionBinding(column))
                }
            }
        }
    }

    private func columnKey(_ column: ImportMappingPage.Detected) -> String {
        model.byIndex ? String(column.index) : column.name
    }

    private func columnLabel(_ column: ImportMappingPage.Detected) -> String {
        if model.byIndex || column.name.isEmpty { return "Column \(column.index + 1)" }
        return column.name
    }

    private func columnBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { model.form.columns[key] ?? "" },
            set: { model.form.columns[key] = $0 }
        )
    }

    private func descriptionBinding(_ column: ImportMappingPage.Detected) -> Binding<Bool> {
        let key = columnKey(column)
        return Binding(
            get: { model.form.descriptionColumns.contains(key) },
            set: { on in model.toggleDescription(key, on: on) }
        )
    }
}

struct ImportMappingPreviewSection: View {
    let model: ImportMappingModel

    private var summary: String {
        if model.valid {
            var text = "\(model.okRows) of the first \(model.preview.count) rows read"
            if model.badRows > 0 { text += ", \(model.badRows) with problems" }
            return text + "."
        }
        return "Choose the columns to see how rows are read."
    }

    var body: some View {
        Section {
            if let message = model.previewError {
                Text(message).foregroundStyle(KeptColor.negative)
            }
            ForEach(Array(model.errors.enumerated()), id: \.offset) { _, error in
                Text(error).font(.footnote).foregroundStyle(KeptColor.negative)
            }
            if model.preview.isEmpty {
                Text("No rows to preview yet.").foregroundStyle(.secondary)
            }
            ForEach(model.preview) { row in
                ImportMappingPreviewRow(row: row)
            }
        } header: {
            HStack {
                Text("Preview")
                if model.loading { ProgressView() }
            }
        } footer: {
            Text(summary)
        }
    }
}

struct ImportMappingPreviewRow: View {
    let row: ImportMappingPage.PreviewRow

    @Environment(\.formats) private var formats

    var body: some View {
        if let tx = row.transaction {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title(tx)).lineLimit(2)
                    Spacer(minLength: 8)
                    AmountText(tx.amount, tx.currency, tone: .signed)
                }
                Text("#\(row.rowNumber) · \(formats.date(tx.bookingDate))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("Row \(row.rowNumber)").font(.caption).foregroundStyle(.secondary)
                Text(row.error ?? "Row could not be read.").foregroundStyle(KeptColor.negative)
            }
        }
    }

    private func title(_ tx: ImportMappingPage.Tx) -> String {
        if let name = tx.counterpartyName, !name.isEmpty { return name }
        if let description = tx.description, !description.isEmpty { return description }
        return "—"
    }
}

struct ImportMappingSampleSection: View {
    let model: ImportMappingModel

    var body: some View {
        Section {
            DisclosureGroup("File contents") {
                if model.sampleRows.isEmpty {
                    Text("The file has no readable rows.").foregroundStyle(.secondary)
                }
                ForEach(Array(model.sampleRows.enumerated()), id: \.offset) { index, cells in
                    Text("\(index + 1)  " + cells.joined(separator: " | "))
                        .font(.caption.monospaced())
                        .fontWeight(index + 1 == model.form.headerRowValue ? .bold : .regular)
                        .lineLimit(2)
                }
            }
        } footer: {
            Text("First \(model.sampleRows.count) of \(ImportText.plural(model.rowCount, "line")) as found in the file; the header row is bold.")
        }
    }
}

/// A picker for one column of the file: by header name, or by position when the file has no header.
struct ImportColumnPicker: View {
    let title: String
    @Binding var selection: String
    let detected: [ImportMappingPage.Detected]
    let byIndex: Bool
    let isRequired: Bool

    init(
        _ title: String,
        selection: Binding<String>,
        detected: [ImportMappingPage.Detected],
        byIndex: Bool,
        isRequired: Bool
    ) {
        self.title = title
        _selection = selection
        self.detected = detected
        self.byIndex = byIndex
        self.isRequired = isRequired
    }

    private func key(_ column: ImportMappingPage.Detected) -> String {
        byIndex ? String(column.index) : column.name
    }

    private func label(_ column: ImportMappingPage.Detected) -> String {
        if byIndex || column.name.isEmpty { return "Column \(column.index + 1)" }
        return column.name
    }

    private var matched: ImportMappingPage.Detected? {
        let wanted = selection.trimmingCharacters(in: .whitespaces).lowercased()
        if wanted.isEmpty { return nil }
        return detected.first { key($0).trimmingCharacters(in: .whitespaces).lowercased() == wanted }
    }

    private var unknown: Bool {
        !selection.isEmpty && matched == nil
    }

    private var resolved: Binding<String> {
        Binding(
            get: {
                if let column = matched { return key(column) }
                return selection
            },
            set: { selection = $0 }
        )
    }

    private var sample: String? {
        guard let column = matched else { return nil }
        let text = column.samples.filter { !$0.isEmpty }.joined(separator: " · ")
        return text.isEmpty ? nil : "e.g. " + text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Picker(title, selection: resolved) {
                Text(isRequired ? "Choose a column" : "None").tag("")
                if unknown {
                    Text(selection).tag(selection)
                }
                ForEach(detected) { column in
                    Text(label(column)).tag(key(column))
                }
            }
            if let sample {
                Text(sample).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            if unknown {
                FieldError("This column is not in the file.")
            }
        }
    }
}
