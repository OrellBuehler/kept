import SwiftUI

enum CategoriesSheet: Identifiable {
    case newCategory
    case editCategory(CategoriesPage.Category)
    case newRule
    case editRule(CategoriesPage.Rule)

    var id: String {
        switch self {
        case .newCategory: return "new-category"
        case let .editCategory(category): return "category-" + category.id
        case .newRule: return "new-rule"
        case let .editRule(rule): return "rule-" + rule.id
        }
    }
}

/// Categories (income and expense, one level of subcategories) and the rules that categorise imported transactions.
struct CategoriesView: View {
    @State private var store = PageStore<CategoriesPage>(path: "settings/categories")
    @State private var sheet: CategoriesSheet?
    @State private var deletingCategory: CategoriesPage.Category?
    @State private var deletingRule: CategoriesPage.Rule?

    var body: some View {
        PageView("Categories", store: store) { page in
            List {
                categoriesSection(page)
                rulesSection(page)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Add category", systemImage: "plus") { sheet = .newCategory }
                    Button("Add rule", systemImage: "plus") { sheet = .newRule }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(item: $sheet) { item in
            sheetContent(item)
        }
        .confirmationDialog(
            "Delete category",
            isPresented: categoryDialog,
            titleVisibility: .visible,
            presenting: deletingCategory
        ) { category in
            Button("Delete \(category.name)", role: .destructive) {
                Task { await deleteCategory(category) }
            }
        } message: { _ in
            Text("Its transactions become uncategorized and its rules and budgets are deleted. Subcategories stay as top-level categories.")
        }
        .confirmationDialog(
            "Delete rule",
            isPresented: ruleDialog,
            titleVisibility: .visible,
            presenting: deletingRule
        ) { rule in
            Button("Delete rule", role: .destructive) {
                Task { await deleteRule(rule) }
            }
        } message: { _ in
            Text("Transactions already categorized by it keep their category.")
        }
    }

    private var categoryDialog: Binding<Bool> {
        Binding(
            get: { deletingCategory != nil },
            set: { if !$0 { deletingCategory = nil } }
        )
    }

    private var ruleDialog: Binding<Bool> {
        Binding(
            get: { deletingRule != nil },
            set: { if !$0 { deletingRule = nil } }
        )
    }

    @ViewBuilder
    private func sheetContent(_ item: CategoriesSheet) -> some View {
        if let page = store.state.value {
            switch item {
            case .newCategory:
                CategoriesCategoryForm(store: store, category: nil, categories: page.categories)
            case let .editCategory(category):
                CategoriesCategoryForm(store: store, category: category, categories: page.categories)
            case .newRule:
                CategoriesRuleForm(store: store, rule: nil, categories: page.categories)
            case let .editRule(rule):
                CategoriesRuleForm(store: store, rule: rule, categories: page.categories)
            }
        }
    }

    // MARK: Categories

    @ViewBuilder
    private func categoriesSection(_ page: CategoriesPage) -> some View {
        Section {
            if page.categories.isEmpty {
                ContentUnavailableView {
                    Label("No categories yet", systemImage: "tag")
                } description: {
                    Text("Create your own, for example \"Groceries\" or \"Salary\".")
                } actions: {
                    Button("Add category") { sheet = .newCategory }
                }
            }
            ForEach(CategoriesLogic.ordered(page.categories)) { category in
                Button {
                    sheet = .editCategory(category)
                } label: {
                    CategoriesCategoryRow(category: category)
                }
                .buttonStyle(.plain)
                .swipeActions {
                    Button(role: .destructive) {
                        deletingCategory = category
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        } header: {
            Text("Categories")
        } footer: {
            Text("Label transactions as expenses or income, optionally one level of subcategories. Set a category on any transaction in an account.")
        }
    }

    // MARK: Rules

    @ViewBuilder
    private func rulesSection(_ page: CategoriesPage) -> some View {
        Section {
            if page.rules.isEmpty {
                Text(page.categories.isEmpty ? "Add a category first, then create rules for it." : "No rules yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(page.rules) { rule in
                Button {
                    sheet = .editRule(rule)
                } label: {
                    CategoriesRuleRow(rule: rule, categories: page.categories)
                }
                .buttonStyle(.plain)
                .swipeActions {
                    Button(role: .destructive) {
                        deletingRule = rule
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
            Button {
                Task { await applyRules() }
            } label: {
                Label("Run on uncategorized", systemImage: "arrow.clockwise")
            }
            .disabled(page.rules.isEmpty || store.busy)
        } header: {
            Text("Rules")
        } footer: {
            Text("Rules categorize new transactions when you import them. The first matching rule wins, lowest priority number first. A category you set by hand is never changed by a rule.")
        }
    }

    // MARK: Actions

    private func deleteCategory(_ category: CategoriesPage.Category) async {
        await store.submit("deleteCategory", form: FormFields(["id": category.id]), showRefusal: true)
    }

    private func deleteRule(_ rule: CategoriesPage.Rule) async {
        await store.submit("deleteRule", form: FormFields(["id": rule.id]), showRefusal: true)
    }

    private func applyRules() async {
        guard let result = await store.submit("applyRules", showRefusal: true) else { return }
        if let applied = try? result.decode(CategoriesApplyResult.self) {
            store.message = CategoriesLogic.appliedMessage(applied)
        }
    }
}

struct CategoriesCategoryRow: View {
    let category: CategoriesPage.Category

    private var subtitle: String {
        let count = category.transactionCount
        return count == 1 ? "1 transaction" : "\(count) transactions"
    }

    private var tint: Color {
        Color(hex: category.color) ?? Color.accentColor
    }

    var body: some View {
        HStack(spacing: 12) {
            if category.parentId != nil {
                Spacer().frame(width: 16)
            }
            IconBadge(CategoriesLogic.symbol(category.icon), tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(category.name).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Pill(
                category.kind == "income" ? "Income" : "Expense",
                color: category.kind == "income" ? KeptColor.positive : Color.secondary
            )
        }
        .contentShape(Rectangle())
    }
}

struct CategoriesRuleRow: View {
    let rule: CategoriesPage.Rule
    let categories: [CategoriesPage.Category]

    private var target: String {
        for category in categories where category.id == rule.categoryId {
            return CategoriesLogic.label(category, in: categories)
        }
        return rule.categoryName ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("If " + CategoriesLogic.conditions(rule))
            Text("then \(target) · priority \(rule.priority)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
