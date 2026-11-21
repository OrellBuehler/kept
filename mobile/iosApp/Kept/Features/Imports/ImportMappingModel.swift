import Foundation
import Observation

struct ImportMappingOption: Identifiable, Sendable {
    let value: String
    let label: String

    var id: String { value }
}

/// The choices of the mapping form, the same as the web's.
enum ImportMappingOptions {
    static let delimiters: [ImportMappingOption] = [
        ImportMappingOption(value: "auto", label: "Detect automatically"),
        ImportMappingOption(value: ",", label: "Comma ( , )"),
        ImportMappingOption(value: ";", label: "Semicolon ( ; )"),
        ImportMappingOption(value: "\t", label: "Tab"),
        ImportMappingOption(value: "|", label: "Pipe ( | )"),
    ]

    static let encodings: [ImportMappingOption] = [
        ImportMappingOption(value: "auto", label: "Detect automatically"),
        ImportMappingOption(value: "utf-8", label: "UTF-8"),
        ImportMappingOption(value: "utf-16le", label: "UTF-16 LE"),
        ImportMappingOption(value: "windows-1252", label: "Windows-1252"),
        ImportMappingOption(value: "iso-8859-1", label: "ISO-8859-1"),
    ]

    static let dateFormats: [ImportMappingOption] = [
        ImportMappingOption(value: "YYYY-MM-DD", label: "YYYY-MM-DD"),
        ImportMappingOption(value: "DD.MM.YYYY", label: "DD.MM.YYYY"),
        ImportMappingOption(value: "DD/MM/YYYY", label: "DD/MM/YYYY"),
        ImportMappingOption(value: "MM/DD/YYYY", label: "MM/DD/YYYY"),
        ImportMappingOption(value: "DD.MM.YY", label: "DD.MM.YY"),
        ImportMappingOption(value: "YYYYMMDD", label: "YYYYMMDD"),
    ]

    static let decimals: [ImportMappingOption] = [
        ImportMappingOption(value: ".", label: "Period ( . )"),
        ImportMappingOption(value: ",", label: "Comma ( , )"),
    ]

    static let thousands: [ImportMappingOption] = [
        ImportMappingOption(value: "", label: "None"),
        ImportMappingOption(value: "'", label: "Apostrophe ( ' )"),
        ImportMappingOption(value: ",", label: "Comma ( , )"),
        ImportMappingOption(value: ".", label: "Period ( . )"),
        ImportMappingOption(value: " ", label: "Space"),
    ]

    static let amountModes: [ImportMappingOption] = [
        ImportMappingOption(value: "single", label: "One amount column (signed)"),
        ImportMappingOption(value: "single_with_indicator", label: "Amount + credit/debit column"),
        ImportMappingOption(value: "split", label: "Separate credit and debit columns"),
    ]
}

/// What the mapping form edits, and how it becomes the profile JSON the server saves.
struct ImportMappingForm: Sendable, Equatable {
    var delimiter = "auto"
    var encoding = "auto"
    var headerRow = "1"
    var skipFooterRows = "0"
    var dateFormat = "YYYY-MM-DD"
    var decimalSeparator = "."
    var thousandsSeparator = ""
    var amountMode = "single"
    var invertSign = false
    var creditValues = "CRDT, Credit, CR, C"
    var debitValues = "DBIT, Debit, DR, D"
    var defaultCurrency = ""
    var columns: [String: String] = [:]
    var descriptionColumns: [String] = []
    /// Columns the form has no field for (original amount and currency): kept as they are.
    var extraColumns: [String: [String]] = [:]
    var twoDigitYearPivot: Int?

    nonisolated static let managedColumns: [String] = [
        "bookingDate", "valueDate", "amount", "credit", "debit", "indicator", "currency",
        "counterpartyName", "counterpartyIban", "reference", "externalId", "balance",
    ]
    nonisolated static let amountColumns: [String] = ["amount", "credit", "debit", "indicator"]

    init() {}

    init(draft: ImportMappingDraft) {
        delimiter = draft.delimiter ?? "auto"
        encoding = draft.encoding ?? "auto"
        headerRow = String(draft.headerRow ?? 1)
        skipFooterRows = String(draft.skipFooterRows ?? 0)
        dateFormat = draft.dateFormat ?? "YYYY-MM-DD"
        decimalSeparator = draft.decimalSeparator ?? "."
        thousandsSeparator = draft.thousandsSeparator ?? ""
        amountMode = draft.amountMode ?? "single"
        invertSign = draft.invertSign ?? false
        if let credit = draft.indicatorCreditValues {
            creditValues = credit.joined(separator: ", ")
        }
        if let debit = draft.indicatorDebitValues {
            debitValues = debit.joined(separator: ", ")
        }
        defaultCurrency = draft.defaultCurrency ?? ""
        twoDigitYearPivot = draft.twoDigitYearPivot
        if let refs = draft.columns {
            for (key, ref) in refs {
                if key == "description" {
                    descriptionColumns = ref.names
                } else if Self.managedColumns.contains(key) {
                    columns[key] = ref.names.first ?? ""
                } else {
                    extraColumns[key] = ref.names
                }
            }
        }
    }

    nonisolated var headerRowValue: Int? {
        guard let value = Int(headerRow.trimmingCharacters(in: .whitespaces)), value >= 0 else { return nil }
        return value
    }

    nonisolated var footerRowsValue: Int? {
        guard let value = Int(skipFooterRows.trimmingCharacters(in: .whitespaces)), value >= 0 else { return nil }
        return value
    }

    nonisolated var layoutValid: Bool {
        headerRowValue != nil && footerRowsValue != nil
    }

    /// The columns that take part for the amount layout.
    nonisolated static func amountKeys(for mode: String) -> [String] {
        switch mode {
        case "single_with_indicator": return ["amount", "indicator"]
        case "split": return ["credit", "debit"]
        default: return ["amount"]
        }
    }

    nonisolated static func splitValues(_ text: String) -> [String] {
        let parts = text.split(whereSeparator: { $0 == "," || $0 == ";" })
        var result: [String] = []
        for part in parts {
            let trimmed = part.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { result.append(trimmed) }
        }
        return result
    }

    nonisolated func profileObject() -> [String: Any] {
        var columnsObject: [String: Any] = [:]
        for (key, names) in extraColumns {
            if names.count == 1 {
                columnsObject[key] = names[0]
            } else {
                columnsObject[key] = names
            }
        }
        let modeKeys = Self.amountKeys(for: amountMode)
        for key in Self.managedColumns {
            let isAmountKey = Self.amountColumns.contains(key)
            let active = !isAmountKey || modeKeys.contains(key)
            if active, let value = columns[key], !value.isEmpty {
                columnsObject[key] = value
            }
        }
        if !descriptionColumns.isEmpty {
            columnsObject["description"] = descriptionColumns
        }

        var object: [String: Any] = [:]
        object["delimiter"] = delimiter
        object["encoding"] = encoding
        object["headerRow"] = headerRowValue ?? 1
        object["skipFooterRows"] = footerRowsValue ?? 0
        object["dateFormat"] = dateFormat
        object["decimalSeparator"] = decimalSeparator
        object["thousandsSeparator"] = thousandsSeparator
        object["amountMode"] = amountMode
        object["invertSign"] = invertSign
        object["columns"] = columnsObject
        if let pivot = twoDigitYearPivot {
            object["twoDigitYearPivot"] = pivot
        }
        if amountMode == "single_with_indicator" {
            let credit = Self.splitValues(creditValues)
            let debit = Self.splitValues(debitValues)
            if !credit.isEmpty { object["indicatorCreditValues"] = credit }
            if !debit.isEmpty { object["indicatorDebitValues"] = debit }
        }
        let currency = defaultCurrency.trimmingCharacters(in: .whitespaces)
        if !currency.isEmpty {
            object["defaultCurrency"] = currency
        }
        return object
    }

    /// The `profile` field of the `save` action.
    nonisolated func profileJSON() -> String {
        let data = try? JSONSerialization.data(withJSONObject: profileObject(), options: [.sortedKeys])
        guard let data, let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    /// The body of the live preview request.
    nonisolated func previewBody() -> Data {
        let body: [String: Any] = ["profile": profileObject()]
        let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return data ?? Data("{}".utf8)
    }
}

/// The state of the mapping editor: the form, and the preview the server answers for it.
@MainActor
@Observable
final class ImportMappingModel {
    let pendingId: String
    let currency: String
    var form: ImportMappingForm
    var name: String
    var detected: [ImportMappingPage.Detected]
    var preview: [ImportMappingPage.PreviewRow]
    var sampleRows: [[String]]
    var errors: [String]
    var valid: Bool
    var rowCount: Int
    var dataRowCount: Int
    var loading = false
    var previewError: String?

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(page: ImportMappingPage) {
        pendingId = page.pendingId
        currency = page.account.currency
        form = ImportMappingForm(draft: page.draft)
        name = page.savedName ?? "\(page.account.name) export"
        detected = page.detected
        preview = page.preview
        sampleRows = page.sampleRows
        errors = page.errors
        valid = page.profile != nil
        rowCount = page.rowCount
        dataRowCount = page.dataRowCount
    }

    var okRows: Int {
        preview.filter { $0.transaction != nil }.count
    }

    var badRows: Int {
        preview.filter { $0.error != nil }.count
    }

    var byIndex: Bool {
        form.headerRowValue == 0
    }

    var canSave: Bool {
        let named = !name.trimmingCharacters(in: .whitespaces).isEmpty
        return valid && previewError == nil && form.layoutValid && !loading && named
    }

    func apply(profile: ImportMappingPage.OtherProfile) {
        var next = ImportMappingForm(draft: profile.profile)
        next.defaultCurrency = currency
        form = next
        name = profile.name
    }

    func toggleDescription(_ key: String, on: Bool) {
        if on {
            if !form.descriptionColumns.contains(key) { form.descriptionColumns.append(key) }
        } else {
            form.descriptionColumns.removeAll { $0 == key }
        }
    }

    /// Called when the form changed: asks the server for a new preview shortly after the last edit.
    func formChanged() {
        refreshTask?.cancel()
        loading = true
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            guard let self else { return }
            await self.refresh()
        }
    }

    private func refresh() async {
        let body = form.previewBody()
        do {
            let result = try await SDKClient.shared.endpoint(
                "imports/\(pendingId)/preview",
                jsonBody: body,
                as: ImportMappingPage.self
            )
            if Task.isCancelled { return }
            detected = result.detected
            preview = result.preview
            sampleRows = result.sampleRows
            errors = result.errors
            valid = result.profile != nil
            rowCount = result.rowCount
            dataRowCount = result.dataRowCount
            previewError = nil
        } catch let error as KeptError {
            if Task.isCancelled { return }
            previewError = error.message
        } catch {
            if Task.isCancelled { return }
            previewError = "The preview could not be loaded."
        }
        loading = false
    }
}
