import Foundation

/// `GET pages/recurring`. Amounts are minor units; payments are negative, income positive.
struct RecurringPage: Decodable, Sendable {
    let series: [Series]
    let totals: [Total]

    struct Series: Decodable, Sendable, Identifiable {
        let id: String
        /// "suggested", "confirmed" or "dismissed".
        let status: String
        let name: String
        let counterpartyIban: String?
        /// "weekly", "monthly", "quarterly" or "yearly".
        let cadence: String
        let currency: String
        let amount: Int64
        let annualCost: Int64
        let monthlyCost: Int64
        let firstDate: String
        let lastDate: String
        let lastAmount: Int64
        let occurrences: Int
        let nextExpected: String
        let overdue: Bool
        let priceChange: PriceChange?
    }

    struct PriceChange: Decodable, Sendable {
        let previous: Int64
        let latest: Int64
        let delta: Int64
    }

    struct Total: Decodable, Sendable, Identifiable {
        let currency: String
        let outflowMonthly: Int64
        let outflowAnnual: Int64
        let inflowMonthly: Int64
        let inflowAnnual: Int64
        var id: String { currency }
    }
}

enum RecurringLogic {
    nonisolated static let cadences: [String] = ["weekly", "monthly", "quarterly", "yearly"]

    nonisolated static func cadenceLabel(_ cadence: String) -> String {
        switch cadence {
        case "weekly": return "Weekly"
        case "monthly": return "Monthly"
        case "quarterly": return "Quarterly"
        case "yearly": return "Yearly"
        default: return cadence
        }
    }

    nonisolated static func series(_ all: [RecurringPage.Series], status: String) -> [RecurringPage.Series] {
        all.filter { $0.status == status }
    }

    /// The text of the amount field: positive, the series keeps its direction.
    nonisolated static func amountText(_ amount: Int64, _ currency: String) -> String {
        let magnitude = amount < 0 ? -amount : amount
        return Formats.amountInput(magnitude, currency)
    }
}
