import Charts
import SwiftUI

/// The year in review: income, expenses and savings per currency, month by month, and the top items.
struct ReviewView: View {
    @State private var store = PageStore<ReviewPage>(path: "review")
    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats

    var body: some View {
        PageView("Year in review", store: store) { page in
            content(page)
        }
    }

    @ViewBuilder
    private func content(_ page: ReviewPage) -> some View {
        List {
            yearSection(page)
            if page.review.currencies.isEmpty {
                emptyState(page)
            } else {
                ForEach(page.review.currencies) { currency in
                    currencySections(currency, year: page.year)
                }
            }
        }
    }

    private func yearSection(_ page: ReviewPage) -> some View {
        let selection = Binding<Int>(
            get: { page.year },
            set: { value in
                store.query["year"] = String(value)
                Task { await store.load() }
            }
        )
        let years = ReviewLogic.years(first: page.firstYear, current: page.currentYear, selected: page.year)
        let note = periodNote(page)
        return Section {
            Picker("Year", selection: selection) {
                ForEach(years, id: \.self) { year in
                    Text(String(year)).tag(year)
                }
            }
            Text(periodTitle(page)).foregroundStyle(.secondary)
        } footer: {
            Text(note)
        }
    }

    private func periodNote(_ page: ReviewPage) -> String {
        var text = "Amounts are shown per currency and never converted. Transfers between your own accounts are left out when the counterparty IBAN matches one of your accounts"
        if page.review.excludedTransfers > 0 {
            text += " (\(page.review.excludedTransfers) left out in \(page.year))"
        }
        text += ". Refunds reduce the category they belong to."
        return text
    }

    private func periodTitle(_ page: ReviewPage) -> String {
        if page.review.partial {
            return "\(page.year) so far, up to \(formats.date(page.review.to))."
        }
        return "January to December \(page.year)."
    }

    private func emptyState(_ page: ReviewPage) -> some View {
        Section {
            ContentUnavailableView {
                Label("No transactions in \(String(page.year))", systemImage: "calendar")
            } description: {
                Text("Import statements for this year to see where your money went.")
            } actions: {
                Button("Import a statement") { router.push(.importFiles) }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    @ViewBuilder
    private func currencySections(_ item: ReviewPage.CurrencyReview, year: Int) -> some View {
        summarySection(item)
        ReviewMonthsSection(item: item)
        flowSection("Income", nodes: item.sankey.left, total: item.sankey.total.value, currency: item.currency)
        flowSection("Where it went", nodes: item.sankey.right, total: item.sankey.total.value, currency: item.currency)
        changesSection(item, year: year)
        counterpartiesSection(item)
        transactionsSection("Largest expenses", item.largestExpenses, currency: item.currency)
        transactionsSection("Largest income", item.largestIncome, currency: item.currency)
    }

    private func summarySection(_ item: ReviewPage.CurrencyReview) -> some View {
        Section(item.currency) {
            LabeledContent("Income") { AmountText(item.income, item.currency) }
            LabeledContent("Expenses") { AmountText(item.expenses, item.currency) }
            LabeledContent("Net saved") { AmountText(item.net, item.currency, tone: .signed, showPlus: true) }
            LabeledContent("Savings rate") { Text(savingsRate(item)).monospacedDigit() }
            LabeledContent("Net worth change") {
                if let netWorth = item.netWorth {
                    AmountText(netWorth.change, item.currency, tone: .signed, showPlus: true)
                } else {
                    Text("n/a").foregroundStyle(.secondary)
                }
            }
        }
    }

    private func savingsRate(_ item: ReviewPage.CurrencyReview) -> String {
        guard let rate = item.savingsRate else { return "n/a" }
        return formats.percent(rate, decimals: 0)
    }

    @ViewBuilder
    private func flowSection(_ title: String, nodes: [ReviewPage.Node], total: Int64, currency: String) -> some View {
        if !nodes.isEmpty {
            Section(title) {
                ForEach(nodes) { node in
                    flowRow(node, total: total, currency: currency)
                }
            }
        }
    }

    private func flowRow(_ node: ReviewPage.Node, total: Int64, currency: String) -> some View {
        let color = Color(hex: node.color) ?? Color.accentColor
        let fraction = ReviewLogic.share(node.value, of: total)
        return VStack(spacing: 6) {
            HStack {
                Circle().fill(color).frame(width: 10, height: 10)
                Text(node.label).lineLimit(1)
                Spacer()
                AmountText(node.value, currency)
            }
            .font(.subheadline)
            ProgressBar(fraction: fraction, color: color)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func changesSection(_ item: ReviewPage.CurrencyReview, year: Int) -> some View {
        Section {
            if !item.hasPreviousYear {
                Text("No \(item.currency) transactions in \(String(year - 1)) to compare with.").foregroundStyle(.secondary)
            } else if item.changes.isEmpty {
                Text("No changes.").foregroundStyle(.secondary)
            }
            if item.hasPreviousYear {
                ForEach(Array(item.changes.enumerated()), id: \.offset) { _, change in
                    changeRow(change, currency: item.currency)
                }
            }
        } header: {
            Text("Biggest changes")
        } footer: {
            Text("Compared with \(String(year - 1)).")
        }
    }

    private func changeRow(_ change: ReviewPage.Change, currency: String) -> some View {
        let side = change.side == "income" ? "Income" : "Expense"
        let subtitle = side + " · " + ReviewLogic.changeLabel(change, formats: formats)
        return ValueRow(change.name, subtitle: subtitle) {
            AmountText(change.change, currency, showPlus: true)
        }
    }

    @ViewBuilder
    private func counterpartiesSection(_ item: ReviewPage.CurrencyReview) -> some View {
        Section("Top counterparties by spend") {
            if item.counterparties.isEmpty {
                Text("No expenses with a counterparty name.").foregroundStyle(.secondary)
            }
            ForEach(item.counterparties) { entry in
                let count = entry.count == 1 ? "1 payment" : "\(entry.count) payments"
                ValueRow(entry.name, subtitle: count) {
                    AmountText(entry.spent, item.currency)
                }
            }
        }
    }

    @ViewBuilder
    private func transactionsSection(_ title: String, _ list: [ReviewPage.Transaction], currency: String) -> some View {
        Section(title) {
            if list.isEmpty {
                Text("None.").foregroundStyle(.secondary)
            }
            ForEach(list) { transaction in
                transactionRow(transaction, currency: currency)
            }
        }
    }

    private func transactionRow(_ transaction: ReviewPage.Transaction, currency: String) -> some View {
        var subtitle = formats.date(transaction.bookingDate)
        if let category = transaction.categoryName { subtitle += " · " + category }
        return ValueRow(transaction.counterparty ?? "No counterparty", subtitle: subtitle) {
            AmountText(transaction.amount, currency, tone: .signed)
        }
    }
}

/// Income and expenses of every month of the year as paired bars.
struct ReviewMonthsSection: View {
    let item: ReviewPage.CurrencyReview
    @Environment(\.formats) private var formats

    private struct Sample: Identifiable {
        let label: String
        let kind: String
        let amount: Double
        var id: String { label + kind }
    }

    private var samples: [Sample] {
        var result: [Sample] = []
        for month in item.months {
            let label = ReviewLogic.monthLabel(month.month, locale: formats.locale)
            result.append(Sample(label: label, kind: "Income", amount: Double(month.income) / 100))
            result.append(Sample(label: label, kind: "Expenses", amount: Double(month.expenses) / 100))
        }
        return result
    }

    var body: some View {
        Section("Month by month") {
            chart
        }
    }

    private var chart: some View {
        let data = samples
        return Chart(data) { sample in
            BarMark(x: .value("Month", sample.label), y: .value("Amount", sample.amount))
                .foregroundStyle(by: .value("Type", sample.kind))
                .position(by: .value("Type", sample.kind))
        }
        .chartForegroundStyleScale(domain: ["Income", "Expenses"], range: [KeptColor.charts[0], KeptColor.charts[4]])
        .chartYAxis(.hidden)
        .frame(height: 180)
        .padding(.vertical, 4)
    }
}
