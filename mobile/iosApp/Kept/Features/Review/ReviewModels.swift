import Foundation

/// `GET pages/review?year=2026`. Amounts are minor units of the currency they sit in; currencies are never converted.
struct ReviewPage: Decodable, Sendable {
    let year: Int
    let currentYear: Int
    let firstYear: Int
    let review: Review

    struct Review: Decodable, Sendable {
        let year: Int
        let from: String
        let to: String
        /// The year is not over: the figures run up to `to`.
        let partial: Bool
        let excludedTransfers: Int
        let currencies: [CurrencyReview]
    }

    struct CurrencyReview: Decodable, Sendable, Identifiable {
        let currency: String
        let income: Int64
        let expenses: Int64
        let net: Int64
        let savingsRate: Double?
        let netWorth: NetWorth?
        let hasPreviousYear: Bool
        let sankey: Flow
        let changes: [Change]
        let counterparties: [Counterparty]
        let largestExpenses: [Transaction]
        let largestIncome: [Transaction]
        let months: [Month]
        var id: String { currency }
    }

    struct NetWorth: Decodable, Sendable {
        let start: Int64
        let end: Int64
        let change: Int64
    }

    /// Income by category on the left, expenses by category (and what was saved) on the right.
    struct Flow: Decodable, Sendable {
        let left: [Node]
        let total: Node
        let right: [Node]
    }

    struct Node: Decodable, Sendable, Identifiable {
        let id: String
        let label: String
        let value: Int64
        let color: String?
        let kind: String
    }

    struct Change: Decodable, Sendable {
        let categoryId: String?
        let name: String
        let color: String?
        /// "income" or "expense".
        let side: String
        let amount: Int64
        let previous: Int64
        let change: Int64
        /// nil when there was nothing the year before.
        let changePct: Double?
    }

    struct Counterparty: Decodable, Sendable, Identifiable {
        let name: String
        let spent: Int64
        let count: Int
        var id: String { name }
    }

    struct Transaction: Decodable, Sendable, Identifiable {
        let id: String
        let bookingDate: String
        let amount: Int64
        let counterparty: String?
        let categoryName: String?
    }

    struct Month: Decodable, Sendable, Identifiable {
        let month: String
        let income: Int64
        let expenses: Int64
        var id: String { month }
    }
}

enum ReviewLogic {
    /// The years the picker offers, newest first, always containing the selected one.
    nonisolated static func years(first: Int, current: Int, selected: Int) -> [Int] {
        let low = min(first, selected)
        let high = max(current, selected)
        var result: [Int] = []
        var year = high
        while year >= low {
            result.append(year)
            year -= 1
        }
        return result
    }

    /// The width of a bar of `value` against `total` (0...1).
    nonisolated static func share(_ value: Int64, of total: Int64) -> Double {
        if total <= 0 { return 0 }
        return min(max(Double(value) / Double(total), 0), 1)
    }

    /// "Jan" for "2026-01".
    nonisolated static func monthLabel(_ month: String, locale: Locale) -> String {
        guard let date = Formats.parseDate(month + "-01") else { return month }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.setLocalizedDateFormatFromTemplate("MMM")
        return formatter.string(from: date)
    }

    /// "+12%", "-5%" or "new" for a change against the year before.
    nonisolated static func changeLabel(_ change: ReviewPage.Change, formats: Formats) -> String {
        guard let pct = change.changePct else { return "new" }
        let text = formats.percent(pct, decimals: 0)
        return change.change > 0 ? "+" + text : text
    }
}
