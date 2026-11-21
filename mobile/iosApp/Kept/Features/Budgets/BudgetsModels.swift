import Foundation

/// `GET pages/budgets`. Amounts are minor units of the currency of the group they sit in.
struct BudgetsPage: Decodable, Sendable {
    let month: String
    /// "share" or "total": how spending on shared accounts is counted.
    let basis: String
    let hasShared: Bool
    let currentMonth: String
    let previousMonth: String
    let nextMonth: String
    let report: Report
    let categories: [Category]
    let currencies: [String]

    struct Report: Decodable, Sendable {
        let month: String
        let currencies: [CurrencyReport]
    }

    struct CurrencyReport: Decodable, Sendable, Identifiable {
        let currency: String
        let rows: [Row]
        let unbudgeted: [Unbudgeted]
        let totalBudget: Int64
        let totalSpent: Int64
        var id: String { currency }
    }

    struct Row: Decodable, Sendable, Identifiable {
        let budgetId: String
        let categoryId: String
        let categoryName: String
        let parentName: String?
        let color: String?
        let icon: String?
        let budget: Int64
        let spent: Int64
        let remaining: Int64
        let over: Bool
        var id: String { budgetId }
    }

    struct Unbudgeted: Decodable, Sendable, Identifiable {
        let categoryId: String
        let categoryName: String
        let parentName: String?
        let color: String?
        let icon: String?
        let spent: Int64
        var id: String { categoryId }
    }

    struct Category: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let parentId: String?
        let kind: String
        let color: String?
        let icon: String?
    }
}

enum BudgetsLogic {
    /// "Parent / Child" for a subcategory, otherwise the name.
    nonisolated static func categoryLabel(_ category: BudgetsPage.Category, in all: [BudgetsPage.Category]) -> String {
        guard let parentId = category.parentId else { return category.name }
        for candidate in all where candidate.id == parentId {
            return candidate.name + " / " + category.name
        }
        return category.name
    }

    /// How much of the budget is used, 0 when the budget is not positive.
    nonisolated static func fraction(spent: Int64, budget: Int64) -> Double {
        if budget <= 0 { return 0 }
        return Double(spent) / Double(budget)
    }

    /// The name of a budget row: "Food / Groceries" for a subcategory.
    nonisolated static func rowName(category: String, parent: String?) -> String {
        if let parent, !parent.isEmpty { return parent + " / " + category }
        return category
    }
}
