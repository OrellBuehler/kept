import Foundation

/// `GET pages/settings/categories`: the category tree and the categorisation rules.
struct CategoriesPage: Decodable, Sendable {
    struct Category: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let name: String
        let parentId: String?
        let kind: String
        let color: String?
        let icon: String?
        let transactionCount: Int
    }

    struct Rule: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let categoryId: String
        let priority: Int
        let counterpartyContains: String?
        let descriptionContains: String?
        let counterpartyIban: String?
        let amountSign: String?
        let categoryName: String?
    }

    let categories: [Category]
    let rules: [Rule]
}

/// What `applyRules` answers.
struct CategoriesApplyResult: Decodable, Sendable {
    let categorized: Int
    let scanned: Int
}

struct CategoriesIconOption: Identifiable, Sendable {
    let name: String
    let symbol: String

    var id: String { name }
}

enum CategoriesLogic {
    /// The icons the server accepts, with the SF Symbol the app shows for each.
    static let icons: [CategoriesIconOption] = [
        CategoriesIconOption(name: "shopping-cart", symbol: "cart"),
        CategoriesIconOption(name: "house", symbol: "house"),
        CategoriesIconOption(name: "utensils", symbol: "fork.knife"),
        CategoriesIconOption(name: "car", symbol: "car"),
        CategoriesIconOption(name: "heart-pulse", symbol: "heart"),
        CategoriesIconOption(name: "plane", symbol: "airplane"),
        CategoriesIconOption(name: "film", symbol: "film"),
        CategoriesIconOption(name: "graduation-cap", symbol: "graduationcap"),
        CategoriesIconOption(name: "shield", symbol: "shield"),
        CategoriesIconOption(name: "receipt", symbol: "doc.text"),
        CategoriesIconOption(name: "wallet", symbol: "creditcard"),
        CategoriesIconOption(name: "gift", symbol: "gift"),
    ]

    /// The colours the web offers.
    static let palette: [String] = [
        "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777", "#7c3aed", "#64748b",
    ]

    nonisolated static func symbol(_ name: String?) -> String {
        guard let name else { return "tag" }
        for option in icons where option.name == name {
            return option.symbol
        }
        return "tag"
    }

    /// Top-level categories in the server's order, each followed by its children. A child whose parent is missing counts as top-level.
    nonisolated static func ordered(_ categories: [CategoriesPage.Category]) -> [CategoriesPage.Category] {
        let ids = Set(categories.map { $0.id })
        var result: [CategoriesPage.Category] = []
        for category in categories {
            let parent = category.parentId ?? ""
            let isTop = category.parentId == nil || !ids.contains(parent)
            if !isTop { continue }
            result.append(category)
            for child in categories where child.parentId == category.id {
                result.append(child)
            }
        }
        return result
    }

    /// "Parent / Child" for a subcategory, otherwise the name.
    nonisolated static func label(_ category: CategoriesPage.Category, in all: [CategoriesPage.Category]) -> String {
        guard let parentId = category.parentId else { return category.name }
        for parent in all where parent.id == parentId {
            return parent.name + " / " + category.name
        }
        return category.name
    }

    /// "counterparty contains "x" and money out".
    nonisolated static func conditions(_ rule: CategoriesPage.Rule) -> String {
        var parts: [String] = []
        if let text = rule.counterpartyContains, !text.isEmpty {
            parts.append("counterparty contains \"\(text)\"")
        }
        if let text = rule.descriptionContains, !text.isEmpty {
            parts.append("description contains \"\(text)\"")
        }
        if let iban = rule.counterpartyIban, !iban.isEmpty {
            parts.append("IBAN is \(iban)")
        }
        if rule.amountSign == "income" { parts.append("money in") }
        if rule.amountSign == "expense" { parts.append("money out") }
        return parts.joined(separator: " and ")
    }

    nonisolated static func appliedMessage(_ result: CategoriesApplyResult) -> String {
        let noun = result.scanned == 1 ? "transaction" : "transactions"
        return "Categorized \(result.categorized) of \(result.scanned) uncategorized \(noun)."
    }
}
