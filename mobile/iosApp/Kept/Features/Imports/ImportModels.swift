import Foundation

/// `GET pages/import`: accounts to import into, recent imports and the watch folder.
struct ImportPage: Decodable, Sendable {
    struct Account: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let name: String
        let currency: String
        let institutionName: String?
        let institution: InstitutionRef?
    }

    struct Recent: Decodable, Sendable, Identifiable {
        let id: String
        let accountId: String
        let accountName: String
        let currency: String
        let format: String
        let fileName: String
        let statementFrom: String?
        let statementTo: String?
        let newCount: Int
        let duplicateCount: Int
        let warnings: [String]
        let createdAt: Int64
    }

    struct LastScan: Decodable, Sendable {
        let at: Int64
        let imported: Int
        let review: Int
        let failed: Int
        let duplicate: Int
        let skipped: Int
    }

    struct InboxEntry: Decodable, Sendable, Identifiable {
        let id: String
        let fileName: String
        let status: String
        let reason: String?
        let accountName: String?
        let newCount: Int?
        let duplicateCount: Int?
        let updatedAt: Int64
    }

    struct Inbox: Decodable, Sendable {
        let enabled: Bool
        let folder: String?
        let lastScan: LastScan?
        let entries: [InboxEntry]
    }

    let accounts: [Account]
    let recentImports: [Recent]
    let inbox: Inbox
    let selectedAccountId: String?
}

/// `GET pages/import/<pendingId>`: the preview of an uploaded statement.
struct ImportPendingPage: Decodable, Sendable {
    struct Account: Decodable, Sendable {
        let id: String
        let name: String
        let currency: String
        let iban: String?
    }

    struct Balance: Decodable, Sendable {
        let amount: Int64
        let currency: String
        let date: String?
    }

    struct Statement: Decodable, Sendable {
        let currency: String?
        let fromDate: String?
        let toDate: String?
        let openingBalance: Balance?
        let closingBalance: Balance?
    }

    struct BalanceWarning: Decodable, Sendable {
        let code: String
        let date: String
        let fileAmount: Int64
        let ledgerAmount: Int64
        let currency: String
    }

    struct Tx: Decodable, Sendable {
        let bookingDate: String
        let amount: Int64
        let currency: String
        let counterpartyName: String?
        let description: String?
        let reference: String?
    }

    struct Row: Decodable, Sendable, Identifiable {
        let index: Int
        let status: String
        let matchedBy: String?
        let tx: Tx

        var id: Int { index }
    }

    struct Counts: Decodable, Sendable {
        let new: Int
        let replacesMirror: Int
        let duplicate: Int
        let total: Int
    }

    let pendingId: String
    let account: Account
    let format: String
    let fileName: String
    let statement: Statement?
    let rows: [Row]
    let counts: Counts
    let warnings: [String]
    let balanceWarnings: [BalanceWarning]
    let errors: [String]
    let alreadyImportedAt: Int64?
    let filter: String
    let page: Int
    let pageSize: Int
    let pageCount: Int
    let filteredTotal: Int
    let needsMapping: Bool
    let canConfirm: Bool
}

/// A column reference of a mapping profile: a header name, a 0-based index (as text) or a list of them.
struct ImportColumnRef: Decodable, Sendable, Equatable {
    var names: [String]

    init(names: [String]) {
        self.names = names
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            names = [text]
        } else if let number = try? container.decode(Int.self) {
            names = [String(number)]
        } else if let list = try? container.decode([ImportColumnRef].self) {
            names = list.flatMap { $0.names }
        } else {
            names = []
        }
    }
}

/// A CSV/XLSX mapping profile as the server sends it (a draft, so every field may be missing).
struct ImportMappingDraft: Decodable, Sendable, Equatable {
    var delimiter: String?
    var encoding: String?
    var headerRow: Int?
    var skipFooterRows: Int?
    var dateFormat: String?
    var twoDigitYearPivot: Int?
    var decimalSeparator: String?
    var thousandsSeparator: String?
    var amountMode: String?
    var invertSign: Bool?
    var indicatorCreditValues: [String]?
    var indicatorDebitValues: [String]?
    var defaultCurrency: String?
    var columns: [String: ImportColumnRef]?
}

/// `GET pages/import/<pendingId>/mapping`, and the answer of the live preview endpoint (which has no `otherProfiles`).
struct ImportMappingPage: Decodable, Sendable {
    struct Account: Decodable, Sendable {
        let id: String
        let name: String
        let currency: String
    }

    struct Detected: Decodable, Sendable, Identifiable {
        let index: Int
        let name: String
        let samples: [String]

        var id: Int { index }
    }

    struct Tx: Decodable, Sendable {
        let bookingDate: String
        let amount: Int64
        let currency: String
        let counterpartyName: String?
        let description: String?
    }

    struct PreviewRow: Decodable, Sendable, Identifiable {
        let rowNumber: Int
        let raw: [String]
        let transaction: Tx?
        let error: String?

        var id: Int { rowNumber }
    }

    struct OtherProfile: Decodable, Sendable, Identifiable {
        let accountId: String
        let accountName: String
        let name: String
        let profile: ImportMappingDraft

        var id: String { accountId }
    }

    let pendingId: String
    let fileName: String
    let format: String
    let account: Account
    let detected: [Detected]
    let sampleRows: [[String]]
    let preview: [PreviewRow]
    let profile: ImportMappingDraft?
    let draft: ImportMappingDraft
    let saved: Bool
    let savedName: String?
    let rowCount: Int
    let dataRowCount: Int
    let errors: [String]
    let otherProfiles: [OtherProfile]?
}

/// Text helpers of the import screens.
enum ImportText {
    nonisolated static func formatLabel(_ format: String) -> String {
        switch format {
        case "camt053": return "camt.053"
        case "camt054": return "camt.054"
        case "mt940": return "MT940"
        case "csv": return "CSV"
        case "xlsx": return "Excel"
        default: return format
        }
    }

    nonisolated static func bytes(_ count: Int) -> String {
        if count < 1024 { return "\(count) B" }
        if count < 1024 * 1024 { return String(format: "%.1f KB", Double(count) / 1024) }
        return String(format: "%.1f MB", Double(count) / (1024 * 1024))
    }

    nonisolated static func plural(_ count: Int, _ one: String) -> String {
        count == 1 ? "1 \(one)" : "\(count) \(one)s"
    }

    /// "12 Mar 2026" or "12 Mar 2026 – 14 Apr 2026"; "No period" when the file declares none.
    nonisolated static func period(_ from: String?, _ to: String?, formats: Formats) -> String {
        if let from, let to {
            if from == to { return formats.date(from) }
            return formats.date(from) + " – " + formats.date(to)
        }
        if let single = from ?? to { return formats.date(single) }
        return "No period"
    }

    /// The date and time of an epoch-millisecond instant, in the device's zone.
    nonisolated static func dateTime(_ ms: Int64, locale: Locale) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// "CH93 0076 …" for "full", the middle masked for "masked", nil for "hidden".
    nonisolated static func iban(_ value: String, display: String) -> String? {
        if display == "hidden" { return nil }
        let compact = value.filter { !$0.isWhitespace }.uppercased()
        var shown = compact
        if display == "masked" {
            if compact.count < 12 {
                shown = String(repeating: "•", count: compact.count)
            } else {
                let head = String(compact.prefix(4))
                let tail = String(compact.suffix(4))
                shown = head + String(repeating: "•", count: compact.count - 8) + tail
            }
        }
        var result = ""
        var position = 0
        for character in shown {
            if position > 0, position % 4 == 0 { result.append(" ") }
            result.append(character)
            position += 1
        }
        return result
    }

    /// The content type to send a statement with, from its file name.
    nonisolated static func contentType(forFileName name: String) -> String {
        let lower = name.lowercased()
        if lower.hasSuffix(".xml") { return "application/xml" }
        if lower.hasSuffix(".csv") { return "text/csv" }
        if lower.hasSuffix(".xlsx") { return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
        return "text/plain"
    }

    /// The server's limit for an uploaded file (`MAX_UPLOAD_BYTES`).
    nonisolated static let maxUploadBytes = 20 * 1024 * 1024
}
