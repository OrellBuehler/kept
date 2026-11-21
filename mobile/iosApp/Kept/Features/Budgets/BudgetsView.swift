import SwiftUI

/// What the budget form edits: a new budget (`row` nil) or an existing one.
struct BudgetsEditor: Identifiable {
    let id = UUID()
    let row: BudgetsPage.Row?
    let currency: String
}

/// Monthly budgets per category: spent against the limit, month by month.
struct BudgetsView: View {
    @State private var store = PageStore<BudgetsPage>(path: "budgets")
    @State private var editor: BudgetsEditor?
    @State private var deleting: BudgetsPage.Row?
    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats
    @Environment(\.session) private var session

    var body: some View {
        PageView("Budgets", store: store) { page in
            content(page)
        }
        .toolbar { toolbar }
        .sheet(item: $editor) { item in
            sheet(item)
        }
        .confirmationDialog(
            "Delete this budget?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { row in
            Button("Delete", role: .destructive) { Task { await delete(row) } }
        } message: { row in
            Text("The budget for \(row.categoryName) is removed. Your transactions are not affected.")
        }
    }

    private var expenseCategories: [BudgetsPage.Category] {
        let all = store.state.value?.categories ?? []
        return all.filter { $0.kind == "expense" }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                editor = BudgetsEditor(row: nil, currency: "")
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("Add budget")
            .disabled(store.state.value == nil || expenseCategories.isEmpty)
        }
    }

    @ViewBuilder
    private func content(_ page: BudgetsPage) -> some View {
        let expense = page.categories.filter { $0.kind == "expense" }
        List {
            monthSection(page)
            if page.hasShared { basisSection(page) }
            if expense.isEmpty {
                emptyCategories
            } else if page.report.currencies.isEmpty {
                emptyBudgets(page)
            } else {
                ForEach(page.report.currencies) { report in
                    currencySection(report)
                }
            }
        }
    }

    private func monthSection(_ page: BudgetsPage) -> some View {
        Section {
            HStack {
                Button {
                    go(to: page.previousMonth)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Previous month")
                Spacer()
                VStack(spacing: 2) {
                    Text(formats.month(page.month)).font(.headline)
                    if page.month != page.currentMonth {
                        Button("This month") { go(to: page.currentMonth) }
                            .buttonStyle(.borderless)
                            .font(.caption)
                    }
                }
                Spacer()
                Button {
                    go(to: page.nextMonth)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Next month")
            }
        }
    }

    private func basisSection(_ page: BudgetsPage) -> some View {
        let selection = Binding<String>(
            get: { page.basis },
            set: { value in
                store.query["basis"] = value
                Task { await store.load() }
            }
        )
        let note = page.basis == "share"
            ? "Spending on shared accounts is counted at your ownership share."
            : "Spending on shared accounts is counted in full."
        return Section {
            Picker("Count shared accounts", selection: selection) {
                Text("My share").tag("share")
                Text("Total").tag("total")
            }
            .pickerStyle(.segmented)
        } footer: {
            Text(note)
        }
    }

    private var emptyCategories: some View {
        Section {
            ContentUnavailableView {
                Label("Create a category first", systemImage: "tag")
            } description: {
                Text("Budgets are set per expense category. Add categories in the settings, then give each transaction a category.")
            } actions: {
                Button("Manage categories") { router.push(.settingsCategories) }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func emptyBudgets(_ page: BudgetsPage) -> some View {
        Section {
            ContentUnavailableView {
                Label("No budgets or spending in \(formats.month(page.month))", systemImage: "chart.pie")
            } description: {
                Text("Add a monthly budget for a category to see how much of it is spent.")
            } actions: {
                Button("Add budget") { editor = BudgetsEditor(row: nil, currency: "") }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    @ViewBuilder
    private func currencySection(_ report: BudgetsPage.CurrencyReport) -> some View {
        Section {
            ForEach(report.rows) { row in
                budgetRow(row, currency: report.currency)
            }
            if report.rows.isEmpty {
                Text("No budgets in this currency.").foregroundStyle(.secondary)
            }
        } header: {
            Text(report.currency)
        } footer: {
            if !report.rows.isEmpty { Text(summary(report)) }
        }
        if !report.unbudgeted.isEmpty {
            Section("Spent without a budget (\(report.currency))") {
                ForEach(report.unbudgeted) { item in
                    unbudgetedRow(item, currency: report.currency)
                }
            }
        }
    }

    private func summary(_ report: BudgetsPage.CurrencyReport) -> String {
        let spent = money(report.totalSpent, report.currency)
        let budget = money(report.totalBudget, report.currency)
        return "\(spent) spent of \(budget) budgeted"
    }

    private func money(_ minor: Int64, _ currency: String) -> String {
        formats.hideAmounts ? "\(currency) •••" : formats.money(minor, currency)
    }

    private func budgetRow(_ row: BudgetsPage.Row, currency: String) -> some View {
        let color = Color(hex: row.color) ?? Color.accentColor
        let name = BudgetsLogic.rowName(category: row.categoryName, parent: row.parentName)
        let fraction = BudgetsLogic.fraction(spent: row.spent, budget: row.budget)
        let spentText = money(row.spent, currency) + " of " + money(row.budget, currency)
        let remainingText = row.over
            ? "Over by " + money(-row.remaining, currency)
            : money(row.remaining, currency) + " left"
        let barColor: Color = row.over ? KeptColor.negative : Color.accentColor
        let textColor: Color = row.over ? KeptColor.negative : Color.secondary
        return Button {
            editor = BudgetsEditor(row: row, currency: currency)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Circle().fill(color).frame(width: 10, height: 10)
                    Text(name).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(spentText)
                        .font(.subheadline)
                        .monospacedDigit()
                        .lineLimit(1)
                        .foregroundStyle(row.over ? KeptColor.negative : Color.primary)
                }
                ProgressBar(fraction: fraction, color: barColor)
                Text(remainingText)
                    .font(.caption)
                    .foregroundStyle(textColor)
            }
            .padding(.vertical, 2)
        }
        .tint(.primary)
        .swipeActions {
            Button(role: .destructive) {
                deleting = row
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .contextMenu {
            Button {
                editor = BudgetsEditor(row: row, currency: currency)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = row
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func unbudgetedRow(_ item: BudgetsPage.Unbudgeted, currency: String) -> some View {
        let color = Color(hex: item.color) ?? Color.secondary
        let name = BudgetsLogic.rowName(category: item.categoryName, parent: item.parentName)
        return HStack {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(name).lineLimit(1)
            Spacer(minLength: 8)
            AmountText(item.spent, currency)
        }
    }

    @ViewBuilder
    private func sheet(_ item: BudgetsEditor) -> some View {
        let defaultCurrency = session?.preferences.defaultCurrency ?? "CHF"
        BudgetsFormSheet(
            store: store,
            row: item.row,
            rowCurrency: item.currency,
            categories: expenseCategories,
            currencies: store.state.value?.currencies ?? [],
            defaultCurrency: defaultCurrency
        )
    }

    private func go(to month: String) {
        store.query["month"] = month
        Task { await store.load() }
    }

    private func delete(_ row: BudgetsPage.Row) async {
        var form = FormFields()
        form.set("id", row.budgetId)
        await store.submit("deleteBudget", form: form, showRefusal: true)
    }
}
