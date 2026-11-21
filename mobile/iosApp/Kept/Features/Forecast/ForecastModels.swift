import Foundation

/// `GET pages/forecast?days=30|60|90`. Amounts are minor units of the currency next to them.
struct ForecastPage: Decodable, Sendable {
    let today: String
    let days: Int
    let horizons: [Int]
    let forecast: Forecast
    let planned: [Planned]
    let settings: [Setting]

    struct Forecast: Decodable, Sendable {
        let from: String
        let to: String
        let days: Int
        let accounts: [Account]
        let items: [Item]
        let unassigned: [Unassigned]
        let unprojectedBills: Unprojected
    }

    struct Account: Decodable, Sendable, Identifiable {
        let accountId: String
        let name: String
        let currency: String
        let hasBalance: Bool
        let startBalance: Int64
        let endBalance: Int64
        let threshold: Int64?
        let points: [Point]
        let lowest: Point
        let warning: Warning?
        let negativeDate: String?
        var id: String { accountId }
    }

    struct Point: Decodable, Sendable {
        let date: String
        let balance: Int64
    }

    struct Warning: Decodable, Sendable {
        let date: String
        let balance: Int64
        let limit: Int64
        let negative: Bool
    }

    struct Item: Decodable, Sendable {
        let date: String
        let amount: Int64
        let currency: String
        let accountId: String?
        /// "bill", "planned", ... (what produced the item).
        let source: String
        let label: String
        let ref: String?
    }

    struct Unassigned: Decodable, Sendable, Identifiable {
        let currency: String
        let inflow: Int64
        let outflow: Int64
        let count: Int
        var id: String { currency }
    }

    struct Unprojected: Decodable, Sendable {
        let noDueDate: Int
        let noAmount: Int
    }

    struct Planned: Decodable, Sendable, Identifiable {
        let id: String
        let accountId: String?
        let date: String
        let amount: Int64
        let currency: String
        let label: String
    }

    struct Setting: Decodable, Sendable {
        let accountId: String
        let threshold: Int64?
        let defaultPayment: Bool
    }
}

enum ForecastLogic {
    /// The label of the source of a projected item.
    nonisolated static func sourceLabel(_ source: String) -> String {
        switch source {
        case "bill": return "Bill"
        case "planned": return "Planned"
        case "recurring": return "Recurring"
        default: return source
        }
    }

    /// "income" for a positive amount, otherwise "expense".
    nonisolated static func direction(_ amount: Int64) -> String {
        amount > 0 ? "income" : "expense"
    }

    /// The text the amount field of a planned item starts with (the sign is the direction).
    nonisolated static func amountText(_ amount: Int64, _ currency: String) -> String {
        let magnitude = amount < 0 ? -amount : amount
        return Formats.amountInput(magnitude, currency)
    }

    /// The name of an account by id, "No account" without one.
    nonisolated static func accountName(_ id: String?, in accounts: [ForecastPage.Account]) -> String {
        guard let id else { return "No account" }
        for account in accounts where account.accountId == id {
            return account.name
        }
        return "Account"
    }

    /// Accounts with a warning, in the order of the page.
    nonisolated static func warnings(_ accounts: [ForecastPage.Account]) -> [ForecastPage.Account] {
        accounts.filter { $0.warning != nil }
    }
}
