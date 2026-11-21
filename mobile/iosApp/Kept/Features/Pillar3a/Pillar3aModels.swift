import Foundation

/// `GET pages/pillar-3a`. All amounts are minor units of CHF.
struct Pillar3aPage: Decodable, Sendable {
    let today: String
    let overview: Overview
    let contributions: [Contribution]
    let accounts: [AccountRef]

    var thisYear: Int { Int(today.prefix(4)) ?? 0 }

    struct Overview: Decodable, Sendable {
        let years: [Year]
        let gaps: [Gap]
        let portfolios: [Portfolio]
        let totals: Totals
        let ageBenefitDrawn: Bool
        let orphanAnnotations: [Orphan]
    }

    struct Totals: Decodable, Sendable {
        let value: Int64
        let contributed: Int64
        let gain: Int64
        let accountsValue: Int64
    }

    struct Year: Decodable, Sendable, Identifiable {
        let year: Int
        let deduction: String
        let earnedIncome: Int64?
        let settingInherited: Bool
        let limit: Int64
        let limitUnconfirmed: Bool
        let ordinary: Int64
        let buyIn: Int64
        let gap: Int64
        let overLimit: Int64
        let closedBy: String?
        let buyInEligible: Bool
        var id: Int { year }
    }

    struct Gap: Decodable, Sendable, Identifiable {
        let year: Int
        let limit: Int64
        let unconfirmed: Bool
        let ordinary: Int64
        let gap: Int64
        let closedBy: String?
        var id: Int { year }
    }

    struct Portfolio: Decodable, Sendable, Identifiable {
        let portfolioId: String
        let accountId: String
        let accountName: String
        let archived: Bool
        let name: String
        let strategy: String?
        let closedOn: String?
        let latestValue: Int64?
        let latestValueDate: String?
        let contributed: Int64
        let gain: Int64?
        var id: String { portfolioId }
    }

    struct Orphan: Decodable, Sendable, Identifiable {
        let id: String
        let portfolioName: String
        let date: String
        let kind: String
        let gapYears: [Int]
        let note: String?
    }

    struct Contribution: Decodable, Sendable {
        let key: String
        /// The contribution row (a manual entry or an annotation); nil for a plain detected payment.
        let id: String?
        let transactionId: String?
        /// "detected" or "manual".
        let source: String
        let portfolioId: String
        let portfolioName: String
        let bookingDate: String?
        let date: String
        let year: Int
        let amount: Int64
        let kind: String
        let gapYears: [Int]
        let note: String?
        let dateOverridden: Bool
        let lateDecemberWarning: String?
    }

    struct AccountRef: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let archived: Bool
    }
}

/// `GET endpoints/pillar-3a/buy-in-check`.
struct Pillar3aBuyInCheck: Decodable, Sendable {
    let errors: [String]
    let warnings: [String]
}

/// What `addContribution` and `updateContribution` answer.
struct Pillar3aSaved: Decodable, Sendable {
    let warnings: [String]?
}

/// Labels and pure helpers of the pillar 3a screens.
enum Pillar3aText {
    static let deductions: [String] = ["small", "large", "none"]

    nonisolated static func deductionLabel(_ deduction: String) -> String {
        switch deduction {
        case "small": return "Small deduction (with a pension fund)"
        case "large": return "Large deduction (no pension fund)"
        case "none": return "No deduction"
        default: return deduction
        }
    }

    /// "2025, 2026" for the gap years of a buy-in, ascending.
    nonisolated static func yearsText(_ years: [Int], separator: String = ", ") -> String {
        let sorted = years.sorted()
        let parts = sorted.map { String($0) }
        return parts.joined(separator: separator)
    }

    /// How much of the limit ordinary contributions fill: 0...1.
    nonisolated static func fraction(ordinary: Int64, limit: Int64) -> Double {
        if limit <= 0 { return 0 }
        let value = Double(ordinary) / Double(limit)
        return min(max(value, 0), 1)
    }

    /// Why a year's limit is only an estimate.
    nonisolated static func limitHint(deduction: String, earnedIncome: Int64?) -> String {
        if deduction == "large", earnedIncome == nil {
            return "Enter your net earned income for the exact limit."
        }
        return "Estimate: this year's limit is not published yet."
    }

    /// The query of the buy-in check, like the web's dialog sends it.
    nonisolated static func checkQuery(date: String, amount: String, gapYears: [Int], key: String?) -> [String: String] {
        var query: [String: String] = [:]
        query["date"] = date
        query["amount"] = amount
        query["gapYears"] = yearsText(gapYears, separator: ",")
        if let key { query["key"] = key }
        return query
    }

    /// The form of a new or edited manual contribution, or of an edited detected payment.
    nonisolated static func contributionForm(
        contribution: Pillar3aPage.Contribution?,
        portfolioId: String,
        amount: String,
        date: String,
        kind: String,
        gapYears: [Int],
        note: String
    ) -> FormFields {
        var form = FormFields()
        form.set("date", date)
        form.set("kind", kind)
        form.set("gapYears", kind == "buy_in" ? yearsText(gapYears, separator: ",") : "")
        form.set("note", note.trimmingCharacters(in: .whitespacesAndNewlines))
        if let contribution {
            if contribution.source == "detected" {
                form.set("transactionId", contribution.transactionId ?? "")
            } else {
                form.set("contributionId", contribution.id ?? "")
                form.set("portfolioId", portfolioId)
                form.set("amount", amount.trimmingCharacters(in: .whitespaces))
            }
        } else {
            form.set("portfolioId", portfolioId)
            form.set("amount", amount.trimmingCharacters(in: .whitespaces))
        }
        return form
    }

    /// The field that deletes (or resets) a contribution: detected payments by transaction, manual ones by id.
    nonisolated static func deleteForm(_ contribution: Pillar3aPage.Contribution) -> FormFields {
        var form = FormFields()
        if contribution.source == "detected" {
            form.set("transactionId", contribution.transactionId ?? "")
        } else {
            form.set("contributionId", contribution.id ?? "")
        }
        return form
    }

    /// The form of a year's deduction setting; the income only counts for the large deduction.
    nonisolated static func yearForm(year: Int, deduction: String, earnedIncome: String) -> FormFields {
        var form = FormFields()
        form.set("year", String(year))
        form.set("deduction", deduction)
        if deduction == "large" {
            form.set("earnedIncome", earnedIncome.trimmingCharacters(in: .whitespaces))
        }
        return form
    }
}
