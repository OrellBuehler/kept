import Foundation

/// How much is owed or expected back, as the tax pages state it.
struct TaxBalance: Decodable, Sendable {
    let paidByMe: Int64
    let creditedByOffice: Int64
    let difference: Int64
    let assessedTotal: Int64?
    let remaining: Int64?
    let remainingByMe: Int64?
    /// "due", "refund", "settled" or "unknown".
    let outcome: String
    let amountDue: Int64
    let refundExpected: Int64
}

/// `GET pages/taxes`.
struct TaxesPage: Decodable, Sendable {
    let years: [Year]
    let defaultYear: Int
    let defaultCurrency: String

    struct Year: Decodable, Sendable, Identifiable {
        let year: Int
        let authority: String?
        let currency: String
        let balance: TaxBalance
        let discrepancies: Int
        let reconciled: Bool
        var id: Int { year }
    }
}

/// `GET pages/taxes/<year>`.
struct TaxYearPage: Decodable, Sendable {
    let reconciliation: Reconciliation
    let deductionMoves: Int
    let deductions: Deductions
    let deductionMappings: [Mapping]
    /// Only present when the user tracks pillar 3a at all.
    let pillar3a: Pillar3a?

    struct Reconciliation: Decodable, Sendable {
        let year: Details
        let rows: [Row]
        let balance: TaxBalance
        let counts: Counts
        let reconciled: Bool
        let otherCurrencyLines: Int
        let suggestions: [Suggestion]

        var differences: Int {
            counts.amountMismatch + counts.missingOffice + counts.missingMine
        }
    }

    struct Details: Decodable, Sendable {
        /// nil while the year only exists through tagged payments.
        let id: String?
        let year: Int
        let authority: String?
        let currency: String
        let assessedTotal: Int64?
        let notes: String?
    }

    struct Counts: Decodable, Sendable {
        let matched: Int
        let amountMismatch: Int
        let missingOffice: Int
        let missingMine: Int

        enum CodingKeys: String, CodingKey {
            case matched
            case amountMismatch = "amount_mismatch"
            case missingOffice = "missing_office"
            case missingMine = "missing_mine"
        }
    }

    struct Row: Decodable, Sendable, Identifiable {
        /// "matched", "amount_mismatch", "missing_office" or "missing_mine".
        let kind: String
        let date: String
        let mine: Payment?
        let office: Credit?
        let difference: Int64

        var id: String { mine?.id ?? office?.id ?? date }
    }

    struct Payment: Decodable, Sendable {
        let id: String
        let transactionId: String
        let accountId: String
        let currency: String
        let date: String
        let amount: Int64
        let reference: String?
        let label: String?
        /// "tagged" or "bill".
        let via: String
    }

    struct Credit: Decodable, Sendable {
        let id: String
        let date: String
        let amount: Int64
        let reference: String?
        let description: String?
    }

    struct Suggestion: Decodable, Sendable, Identifiable {
        let creditId: String
        let transactionId: String
        let accountId: String
        let bookingDate: String
        let amount: Int64
        let label: String?
        var id: String { creditId + transactionId }
    }

    struct Deductions: Decodable, Sendable {
        let year: Int
        let totals: [Total]
        let excluded: [Line]
    }

    struct Total: Decodable, Sendable, Identifiable {
        let type: String
        let currency: String
        let total: Int64
        let lines: [Line]
        var id: String { type + currency }
    }

    struct Line: Decodable, Sendable, Identifiable {
        let key: String
        /// nil for a manual pillar 3a contribution, which has no transaction.
        let transactionId: String?
        let source: String
        let date: String
        let label: String?
        let amount: Int64
        let currency: String
        let excluded: Bool
        let explicitYear: Bool
        /// Only on the excluded lines.
        let type: String?
        var id: String { key }
    }

    struct Mapping: Decodable, Sendable, Identifiable {
        let categoryId: String
        let name: String
        let parentId: String?
        /// Set on the category itself.
        let own: String?
        /// Own mapping, else the parent's.
        let effective: String?
        let inherited: Bool
        var id: String { categoryId }
    }

    struct Pillar3a: Decodable, Sendable {
        let limit: Int64?
        let limitUnconfirmed: Bool
        let ordinary: Int64
        let buyIn: Int64
        let deductible: Int64
        let excluded: Int64
    }
}

/// Labels and pure helpers of the tax screens.
enum TaxText {
    static let deductionTypes: [String] = [
        "pillar_3a", "donations", "medical", "childcare", "commuting", "education", "debt_interest", "alimony", "other",
    ]

    nonisolated static func deductionLabel(_ type: String) -> String {
        switch type {
        case "pillar_3a": return "Pillar 3a contributions"
        case "donations": return "Donations"
        case "medical": return "Medical and health costs"
        case "childcare": return "Childcare"
        case "commuting": return "Commuting"
        case "education": return "Further education"
        case "debt_interest": return "Debt interest"
        case "alimony": return "Alimony"
        case "other": return "Other deductions"
        default: return type
        }
    }

    /// The "none" choice of a category's deduction type: what the category falls back to.
    nonisolated static func mappingNoneLabel(inherited: Bool, effective: String?) -> String {
        if inherited, let effective {
            return "Inherited: " + deductionLabel(effective)
        }
        return "Not a deduction"
    }

    nonisolated static func setDeductionForm(categoryId: String, type: String) -> FormFields {
        var form = FormFields()
        form.set("categoryId", categoryId)
        form.set("deductionType", type)
        return form
    }

    nonisolated static func transactionForm(_ transactionId: String) -> FormFields {
        var form = FormFields()
        form.set("transactionId", transactionId)
        return form
    }

    nonisolated static func rowLabel(_ kind: String) -> String {
        switch kind {
        case "matched": return "Matched"
        case "amount_mismatch": return "Amount differs"
        case "missing_office": return "Not counted by tax office"
        case "missing_mine": return "Not in your payments"
        default: return kind
        }
    }

    /// "Due", "Refund", "Settled" or "No assessment", with the amount for the first two.
    nonisolated static func outcomeLabel(_ balance: TaxBalance) -> String {
        switch balance.outcome {
        case "due": return "Due"
        case "refund": return "Refund"
        case "settled": return "Settled"
        default: return "No assessment"
        }
    }

    /// The amount that belongs to the outcome; nil when there is none to show.
    nonisolated static func outcomeAmount(_ balance: TaxBalance) -> Int64? {
        switch balance.outcome {
        case "due": return balance.amountDue
        case "refund": return balance.refundExpected
        default: return nil
        }
    }

    /// "1 difference", "3 differences".
    nonisolated static func differencesText(_ count: Int) -> String {
        count == 1 ? "1 difference" : "\(count) differences"
    }

    /// The form of the "tax year" details (create and save).
    nonisolated static func detailsForm(
        year: String?,
        authority: String,
        currency: String,
        assessedTotal: String,
        notes: String
    ) -> FormFields {
        var form = FormFields()
        if let year { form.set("year", year) }
        form.set("authority", authority.trimmingCharacters(in: .whitespaces))
        form.set("currency", currency.trimmingCharacters(in: .whitespaces))
        form.set("assessedTotal", assessedTotal.trimmingCharacters(in: .whitespaces))
        form.set("notes", notes.trimmingCharacters(in: .whitespacesAndNewlines))
        return form
    }

    /// The form of a statement line of the tax office.
    nonisolated static func creditForm(date: String, amount: String, reference: String, description: String) -> FormFields {
        var form = FormFields()
        form.set("bookingDate", date)
        form.set("amount", amount.trimmingCharacters(in: .whitespaces))
        form.set("reference", reference.trimmingCharacters(in: .whitespaces))
        form.set("description", description.trimmingCharacters(in: .whitespacesAndNewlines))
        return form
    }
}
