import Foundation

/// A bill with its derived status, as the list, the groups and the detail page carry it.
struct BillRecord: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let kind: String
    var creditorName: String?
    var creditorIban: String?
    var amount: Int64?
    let currency: String
    var issueDate: String?
    var dueDate: String?
    var reference: String?
    var referenceType: String?
    var message: String?
    var invoiceNumber: String?
    let cancelled: Bool
    var documentId: String?
    var expectedAccountId: String?
    var notes: String?
    var taxYear: Int?
    var externalUrl: String?
    let status: String
    let settled: Int64
    var remaining: Int64?
    let overdue: Bool
    var dueInDays: Int?
    var lastPaymentDate: String?
    let allocationCount: Int
}

/// The transaction fields the bill screens show.
struct BillTransaction: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let accountId: String
    let accountName: String
    let bookingDate: String
    let amount: Int64
    let currency: String
    var counterpartyName: String?
    var description: String?
    var reference: String?

    var title: String {
        if let counterpartyName, !counterpartyName.isEmpty { return counterpartyName }
        if let description, !description.isEmpty { return description }
        return "Transaction"
    }
}

/// A transaction that could pay the bill, with how much of it is still free.
struct BillCandidate: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let accountId: String
    let accountName: String
    let bookingDate: String
    let amount: Int64
    let currency: String
    var counterpartyName: String?
    var description: String?
    var reference: String?
    let unallocated: Int64
    let suggestedAmount: Int64

    var title: String {
        if let counterpartyName, !counterpartyName.isEmpty { return counterpartyName }
        if let description, !description.isEmpty { return description }
        return "Transaction"
    }
}

/// A payment the server proposes for a bill.
struct BillSuggestion: Decodable, Sendable, Identifiable, Hashable {
    let billId: String
    let transactionId: String
    let rule: String
    let confidence: String
    let amount: Int64
    let ambiguous: Bool
    let auto: Bool
    let bill: BillRef
    let transaction: BillTransaction

    var id: String { billId + ":" + transactionId }

    struct BillRef: Decodable, Sendable, Hashable {
        let id: String
        let kind: String
        var creditorName: String?
        var invoiceNumber: String?
        var amount: Int64?
        let currency: String
        var dueDate: String?
    }
}

struct BillAccountOption: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let currency: String
}

/// What the server read from an uploaded PDF.
struct BillExtraction: Decodable, Sendable {
    var source: String?
    var warnings: [String]?
}

/// Form values proposed from a PDF; every field is text, as the form takes it.
struct BillDraft: Decodable, Sendable {
    var kind: String?
    var creditorName: String?
    var creditorIban: String?
    var amount: String?
    var currency: String?
    var issueDate: String?
    var dueDate: String?
    var reference: String?
    var referenceType: String?
    var message: String?
    var invoiceNumber: String?
}

/// `GET pages/bills` (the web's "/bills").
struct BillsPage: Decodable, Sendable {
    let today: String
    let groups: Groups
    let suggestions: [BillSuggestion]
    let suggestionsTruncated: Bool
    let matchingFailed: Bool
    let counts: Counts
    let autoMatchPending: Int
    let query: Query
    let list: Listing

    struct Groups: Decodable, Sendable {
        let overdue: [BillRecord]
        let dueSoon: [BillRecord]
        let awaitingRefund: [BillRecord]
    }

    struct Counts: Decodable, Sendable {
        let overdue: Int
        let dueSoon: Int
        let awaitingRefund: Int
        let paid: Int
        let total: Int
    }

    struct Query: Decodable, Sendable {
        let q: String
        let status: String
        let page: Int
    }

    struct Listing: Decodable, Sendable {
        let items: [BillRecord]
        let total: Int
        let page: Int
        let pageSize: Int
        let pageCount: Int
    }
}

/// The answer of the `matchNow` action.
struct BillsMatchResult: Decodable, Sendable {
    var matched: Int?
}

/// `GET pages/bills/<id>`.
struct BillDetailPage: Decodable, Sendable {
    let bill: BillRecord
    let links: [ExternalLink]
    let allocations: [Allocation]
    let suggestions: [BillSuggestion]
    let dismissed: [BillTransaction]
    let candidates: Candidates
    let candidateQuery: String
    let accounts: [BillAccountOption]
    var document: Document?

    struct ExternalLink: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let label: String
        let url: String
        var source: String?
    }

    struct Allocation: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let billId: String
        let amount: Int64
        let origin: String
        let transaction: BillTransaction
    }

    struct Candidates: Decodable, Sendable {
        let items: [BillCandidate]
        let total: Int
        let page: Int
        let pageSize: Int
        let pageCount: Int
    }

    struct Document: Decodable, Sendable {
        let id: String
        let fileName: String
        let mimeType: String
        let size: Int
    }
}

/// `GET pages/bills/new`, with `document=<id>` once a PDF was uploaded.
struct BillNewPage: Decodable, Sendable {
    let accounts: [BillAccountOption]
    var draft: BillDraft?
    var documentId: String?
    var extraction: BillExtraction?
}

/// The answer of the `reextract` action.
struct BillReextractResult: Decodable, Sendable {
    var draft: BillDraft?
    var extraction: BillExtraction?
}

/// Everything the bill form edits, as the text typed into the fields.
struct BillFormValues: Sendable, Equatable {
    var kind = "invoice"
    var creditorName = ""
    var creditorIban = ""
    var amount = ""
    var currency = "CHF"
    var issueDate = ""
    var dueDate = ""
    var reference = ""
    var referenceType = ""
    var message = ""
    var invoiceNumber = ""
    var expectedAccountId = ""
    var notes = ""
    var taxYear = ""

    nonisolated static func empty(currency: String) -> BillFormValues {
        var values = BillFormValues()
        values.currency = currency
        return values
    }

    nonisolated static func from(_ bill: BillRecord) -> BillFormValues {
        var values = BillFormValues()
        values.kind = bill.kind
        values.creditorName = bill.creditorName ?? ""
        values.creditorIban = bill.creditorIban.map { BillText.groupIban($0) } ?? ""
        if let amount = bill.amount {
            values.amount = Formats.amountInput(amount, bill.currency)
        }
        values.currency = bill.currency
        values.issueDate = bill.issueDate ?? ""
        values.dueDate = bill.dueDate ?? ""
        values.reference = bill.reference.map { BillText.groupReference($0) } ?? ""
        values.referenceType = bill.referenceType ?? ""
        values.message = bill.message ?? ""
        values.invoiceNumber = bill.invoiceNumber ?? ""
        values.expectedAccountId = bill.expectedAccountId ?? ""
        values.notes = bill.notes ?? ""
        if let year = bill.taxYear { values.taxYear = String(year) }
        return values
    }

    /// The values read from a PDF on top of `base`. Like the web: only fields the PDF provided
    /// replace stored ones, the kind never changes, and the currency changes only for a QR code
    /// and while no payments are matched.
    nonisolated static func merged(
        _ base: BillFormValues,
        with draft: BillDraft,
        source: String?,
        hasAllocations: Bool
    ) -> BillFormValues {
        var values = base
        func take(_ value: String?, into target: inout String) {
            if let value, !value.isEmpty { target = value }
        }
        take(draft.creditorName, into: &values.creditorName)
        take(draft.creditorIban, into: &values.creditorIban)
        take(draft.amount, into: &values.amount)
        take(draft.issueDate, into: &values.issueDate)
        take(draft.dueDate, into: &values.dueDate)
        take(draft.reference, into: &values.reference)
        take(draft.referenceType, into: &values.referenceType)
        take(draft.message, into: &values.message)
        take(draft.invoiceNumber, into: &values.invoiceNumber)
        if !values.creditorIban.isEmpty { values.creditorIban = BillText.groupIban(values.creditorIban) }
        if !values.reference.isEmpty { values.reference = BillText.groupReference(values.reference) }
        if source == "qr", !hasAllocations, let currency = draft.currency, !currency.isEmpty {
            values.currency = currency
        }
        return values
    }

    /// The values a new bill starts with: the draft read from a PDF over an empty form.
    nonisolated static func from(draft: BillDraft?, currency: String) -> BillFormValues {
        let empty = BillFormValues.empty(currency: currency)
        guard let draft else { return empty }
        var values = empty
        if let kind = draft.kind, !kind.isEmpty { values.kind = kind }
        values.creditorName = draft.creditorName ?? ""
        values.creditorIban = draft.creditorIban.map { BillText.groupIban($0) } ?? ""
        values.amount = draft.amount ?? ""
        if let draftCurrency = draft.currency, !draftCurrency.isEmpty { values.currency = draftCurrency }
        values.issueDate = draft.issueDate ?? ""
        values.dueDate = draft.dueDate ?? ""
        values.reference = draft.reference.map { BillText.groupReference($0) } ?? ""
        values.referenceType = draft.referenceType ?? ""
        values.message = draft.message ?? ""
        values.invoiceNumber = draft.invoiceNumber ?? ""
        return values
    }

    /// What the web form sends: every field as text, empty ones as "".
    nonisolated func formFields(documentId: String?) -> FormFields {
        var form = FormFields()
        form.set("kind", kind)
        form.set("creditorName", creditorName.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("creditorIban", creditorIban.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("amount", amount.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("currency", currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
        form.set("issueDate", issueDate)
        form.set("dueDate", dueDate)
        form.set("reference", reference.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("referenceType", referenceType)
        form.set("message", message.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("invoiceNumber", invoiceNumber.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("expectedAccountId", expectedAccountId)
        form.set("notes", notes.trimmingCharacters(in: .whitespacesAndNewlines))
        form.set("taxYear", taxYear.trimmingCharacters(in: .whitespacesAndNewlines))
        if let documentId, !documentId.isEmpty { form.set("documentId", documentId) }
        return form
    }
}

/// Text helpers of the bill screens. Pure, so they are tested.
enum BillText {
    nonisolated static let statusOptions: [(value: String, label: String)] = [
        ("all", "All"), ("open", "Open"), ("overdue", "Overdue"), ("paid", "Paid"),
        ("refund", "Awaiting refund"), ("cancelled", "Cancelled"),
    ]

    nonisolated static func statusLabel(_ status: String) -> String {
        switch status {
        case "open": return "Open"
        case "partially_paid": return "Partially paid"
        case "paid": return "Paid"
        case "overpaid": return "Overpaid"
        case "credit_due": return "Credit due"
        case "cancelled": return "Cancelled"
        default: return status
        }
    }

    nonisolated static func kindLabel(_ kind: String) -> String {
        kind == "credit_note" ? "Credit note" : "Invoice"
    }

    nonisolated static func referenceTypeLabel(_ type: String) -> String {
        switch type {
        case "QRR": return "QR reference (QRR)"
        case "SCOR": return "Creditor reference (SCOR)"
        case "NON": return "No reference (NON)"
        default: return "Detect automatically"
        }
    }

    nonisolated static func plural(_ count: Int, _ unit: String) -> String {
        "\(count) \(unit)" + (count == 1 ? "" : "s")
    }

    /// "3 days overdue", "Due in 5 days"; nil when the hint would add nothing.
    nonisolated static func dueHint(dueInDays: Int?, overdue: Bool, status: String) -> String? {
        guard let days = dueInDays else { return nil }
        if overdue { return plural(-days, "day") + " overdue" }
        if status != "open", status != "partially_paid" { return nil }
        if days == 0 { return "Due today" }
        if days == 1 { return "Due tomorrow" }
        if days > 1 { return "Due in \(days) days" }
        return nil
    }

    /// Whether a refund is expected: a credit note nobody paid out yet, or an invoice paid twice.
    nonisolated static func refundExpected(status: String) -> Bool {
        status == "credit_due" || status == "overpaid"
    }

    nonisolated static func normalizeIban(_ input: String) -> String {
        input.filter { !$0.isWhitespace }.uppercased()
    }

    /// An IBAN in groups of four, upper case.
    nonisolated static func groupIban(_ input: String) -> String {
        groupsOfFour(normalizeIban(input))
    }

    /// Country and check digits and the last four characters stay visible.
    nonisolated static func maskIban(_ input: String) -> String {
        let iban = normalizeIban(input)
        if iban.count < 12 { return groupsOfFour(String(repeating: "\u{2022}", count: iban.count)) }
        let middle = String(repeating: "\u{2022}", count: iban.count - 8)
        return groupsOfFour(String(iban.prefix(4)) + middle + String(iban.suffix(4)))
    }

    /// QR references as 2 + 5x5 digits, creditor references (RF...) in fours; anything else trimmed.
    nonisolated static func groupReference(_ input: String) -> String {
        let reference = normalizeIban(input)
        let isQrr = reference.count == 27 && reference.allSatisfy { $0.isASCII && $0.isNumber }
        if isQrr {
            let head = String(reference.prefix(2))
            let rest = Array(reference.dropFirst(2))
            var groups: [String] = []
            var index = 0
            while index < rest.count {
                let end = min(index + 5, rest.count)
                groups.append(String(rest[index ..< end]))
                index = end
            }
            return ([head] + groups).joined(separator: " ")
        }
        let isScor = reference.hasPrefix("RF") && reference.count > 3
            && reference.allSatisfy { $0.isASCII && ($0.isNumber || $0.isLetter) }
        if isScor { return groupsOfFour(reference) }
        return input.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated static func groupsOfFour(_ text: String) -> String {
        let characters = Array(text)
        var groups: [String] = []
        var index = 0
        while index < characters.count {
            let end = min(index + 4, characters.count)
            groups.append(String(characters[index ..< end]))
            index = end
        }
        return groups.joined(separator: " ")
    }

    /// The digits of an amount the user would paste into an e-banking form ("1949.75").
    nonisolated static func payableAmount(_ bill: BillRecord) -> Int64? {
        if let remaining = bill.remaining { return remaining > 0 ? remaining : nil }
        return bill.amount
    }

    /// Only web links are opened from the app.
    nonisolated static func webURL(_ text: String?) -> URL? {
        guard let text, let url = URL(string: text), let scheme = url.scheme?.lowercased() else { return nil }
        return scheme == "http" || scheme == "https" ? url : nil
    }

    nonisolated static func fileSize(_ bytes: Int) -> String {
        if bytes < 1024 * 1024 { return "\(max(1, Int((Double(bytes) / 1024).rounded()))) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
    }

    /// The `document` query value of "/bills/new?document=<id>".
    nonisolated static func documentId(inRedirect redirect: String?) -> String? {
        guard let redirect, let components = URLComponents(string: redirect) else { return nil }
        let value = components.queryItems?.first { $0.name == "document" }?.value
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// A name that is safe in the temporary directory.
    nonisolated static func safeFileName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
        let cleaned = String(last.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" ? $0 : "_" })
        let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "._"))
        return trimmed.isEmpty ? "bill.pdf" : String(trimmed.prefix(80))
    }

    /// "24-26 of 53".
    nonisolated static func pageRange(page: Int, pageSize: Int, total: Int) -> String {
        if total == 0 { return "0 of 0" }
        let first = (page - 1) * pageSize + 1
        let last = min(total, page * pageSize)
        return "\(first)\u{2013}\(last) of \(total)"
    }
}

/// The forms of the bill actions.
enum BillForms {
    nonisolated static func confirm(billId: String?, transactionId: String, amount: Int64, currency: String) -> FormFields {
        var form = FormFields()
        if let billId { form.set("billId", billId) }
        form.set("transactionId", transactionId)
        form.set("amount", Formats.amountInput(amount, currency))
        return form
    }

    nonisolated static func dismiss(billId: String?, transactionId: String) -> FormFields {
        var form = FormFields()
        if let billId { form.set("billId", billId) }
        form.set("transactionId", transactionId)
        return form
    }

    nonisolated static func transaction(_ transactionId: String) -> FormFields {
        var form = FormFields()
        form.set("transactionId", transactionId)
        return form
    }

    nonisolated static func allocation(_ allocationId: String) -> FormFields {
        var form = FormFields()
        form.set("allocationId", allocationId)
        return form
    }
}
