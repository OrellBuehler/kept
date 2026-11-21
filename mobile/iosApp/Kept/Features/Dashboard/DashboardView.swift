import Charts
import SwiftUI

/// The overview: net worth, this month, what is due, where the money went, and every account.
struct DashboardView: View {
    @State private var store = PageStore<DashboardPage>(path: "dashboard", query: ["range": "12m"])
    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats

    private static let ranges: [(value: String, label: String)] = [
        ("3m", "3M"), ("6m", "6M"), ("12m", "12M"), ("all", "All"),
    ]

    var body: some View {
        PageView("Overview", store: store) { page in
            List {
                alerts(page)
                netWorth(page.dashboard)
                month(page.dashboard.shareMonth ?? page.dashboard.month)
                bills(page.dashboard.bills)
                spending(page.dashboard.spending)
                accounts(page.dashboard.accounts)
            }
        }
    }

    private var range: Binding<String> {
        Binding(
            get: { store.query["range"] ?? "12m" },
            set: { value in
                store.query["range"] = value
                Task { await store.load() }
            }
        )
    }

    @ViewBuilder
    private func alerts(_ page: DashboardPage) -> some View {
        let dashboard = page.dashboard
        let hasAlerts = !page.forecastAlerts.isEmpty || !page.needsAmount.isEmpty
            || dashboard.unmatched.count > 0 || dashboard.staleAccounts > 0
        if hasAlerts {
            Section {
                ForEach(page.forecastAlerts) { alert in
                    alertRow("\(alert.name) is heading below zero", "Forecast for \(formats.date(alert.date))") {
                        router.push(.forecast)
                    }
                }
                ForEach(page.needsAmount) { transfer in
                    alertRow(
                        "Transfer to \(transfer.targetAccountName) needs the amount received",
                        formats.date(transfer.bookingDate)
                    ) {
                        router.push(.account(transfer.sourceAccountId))
                    }
                }
                if dashboard.unmatched.count > 0 {
                    alertRow(
                        dashboard.unmatched.count == 1
                            ? "1 payment could match a bill"
                            : "\(dashboard.unmatched.count) payments could match a bill",
                        nil
                    ) {
                        router.tab = .bills
                    }
                }
                if dashboard.staleAccounts > 0 {
                    alertRow(
                        dashboard.staleAccounts == 1
                            ? "1 account has no recent import"
                            : "\(dashboard.staleAccounts) accounts have no recent import",
                        nil
                    ) {
                        router.push(.importFiles)
                    }
                }
            }
        }
    }

    private func alertRow(_ title: String, _ subtitle: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ValueRow(title, subtitle: subtitle, systemImage: "exclamationmark.triangle", tint: KeptColor.warning) {
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
            }
        }
        .tint(.primary)
    }

    @ViewBuilder
    private func netWorth(_ dashboard: Dashboard) -> some View {
        let series = dashboard.netWorth.shareSeries ?? dashboard.netWorth.series
        Section {
            if dashboard.netWorth.totals.isEmpty {
                Text("Add an account to see your net worth.").foregroundStyle(.secondary)
            } else {
                ForEach(dashboard.netWorth.totals) { total in
                    VStack(alignment: .leading, spacing: 8) {
                        AmountText(total.shareBalance, total.currency, tone: .negative)
                            .font(.title.weight(.semibold))
                        let points = series.first { $0.currency == total.currency }?.points ?? []
                        if points.count >= 2 {
                            NetWorthChart(points: points)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Picker("Range", selection: range) {
                    ForEach(Self.ranges, id: \.value) { item in
                        Text(item.label).tag(item.value)
                    }
                }
                .pickerStyle(.segmented)
            }
        } header: {
            Text("Net worth")
        } footer: {
            if dashboard.hasShared { Text("Shared accounts counted at your share.") }
        }
    }

    @ViewBuilder
    private func month(_ month: Dashboard.MonthSummary) -> some View {
        Section(formats.month(month.month)) {
            if month.totals.isEmpty {
                Text("No transactions this month yet.").foregroundStyle(.secondary)
            }
            ForEach(month.totals) { total in
                LabeledContent("Income") { AmountText(total.income, total.currency) }
                LabeledContent("Expenses") { AmountText(total.expenses, total.currency) }
                LabeledContent("Net") {
                    AmountText(total.net, total.currency, tone: .signed, showPlus: true).fontWeight(.semibold)
                }
                if let previous = month.previousTotals.first(where: { $0.currency == total.currency }) {
                    LabeledContent(formats.month(month.previousMonth)) {
                        AmountText(previous.net, previous.currency, showPlus: true)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func bills(_ bills: Dashboard.Bills) -> some View {
        Section("Bills") {
            HStack {
                count("Overdue", bills.overdue.count, alarming: bills.overdue.count > 0)
                count("Due soon", bills.dueSoon.count, alarming: false)
                count("Refunds", bills.awaitingRefund.count, alarming: false)
            }
            ForEach(bills.upcoming) { bill in
                NavigationLink(value: Route.bill(bill.id)) {
                    ValueRow(
                        bill.creditorName ?? bill.invoiceNumber ?? "Bill",
                        subtitle: bill.dueDate.map { "Due \(formats.date($0))" }
                    ) {
                        if let amount = bill.remaining ?? bill.amount {
                            AmountText(amount, bill.currency)
                        }
                    }
                }
            }
        }
    }

    private func count(_ label: String, _ value: Int, alarming: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.title2.weight(.semibold))
                .foregroundStyle(alarming ? KeptColor.negative : Color.primary)
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func spending(_ spending: Dashboard.Spending) -> some View {
        let currencies = spending.currencies.filter { !$0.items.isEmpty }
        if !currencies.isEmpty {
            Section("Spending in \(formats.month(spending.month))") {
                ForEach(currencies) { currency in
                    let largest = max(currency.items.map(\.spent).max() ?? 1, 1)
                    ForEach(Array(currency.items.enumerated()), id: \.offset) { index, item in
                        let color = Color(hex: item.color) ?? KeptColor.charts[index % KeptColor.charts.count]
                        VStack(spacing: 6) {
                            HStack {
                                Circle().fill(color).frame(width: 10, height: 10)
                                Text(item.name.isEmpty ? "Uncategorised" : item.name).lineLimit(1)
                                Spacer()
                                AmountText(item.spent, currency.currency)
                            }
                            .font(.subheadline)
                            ProgressBar(fraction: Double(item.spent) / Double(largest), color: color)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func accounts(_ accounts: [Dashboard.Account]) -> some View {
        if !accounts.isEmpty {
            Section("Accounts") {
                ForEach(accounts) { account in
                    NavigationLink(value: Route.account(account.id)) {
                        ValueRow(
                            account.name,
                            subtitle: account.institution?.name,
                            systemImage: "building.columns",
                            tint: Color(hex: account.institution?.color) ?? .accentColor
                        ) {
                            AmountText(account.balance, account.currency, tone: .negative)
                            if account.stale {
                                Image(systemName: "exclamationmark.triangle")
                                    .font(.caption)
                                    .foregroundStyle(KeptColor.warning)
                                    .accessibilityLabel("No recent import")
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Net worth over time: a line with a soft fill.
private struct NetWorthChart: View {
    let points: [Dashboard.CurrencySeries.Point]

    private struct Sample: Identifiable {
        let date: Date
        let amount: Double
        var id: Date { date }
    }

    private var data: [Sample] {
        points.compactMap { point in
            Formats.parseDate(point.date).map { Sample(date: $0, amount: Double(point.amount) / 100) }
        }
    }

    var body: some View {
        let data = data
        let low = data.map(\.amount).min() ?? 0
        Chart(data) { item in
            AreaMark(x: .value("Date", item.date), yStart: .value("Low", low), yEnd: .value("Amount", item.amount))
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.22), Color.accentColor.opacity(0)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            LineMark(x: .value("Date", item.date), y: .value("Amount", item.amount))
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
        .chartYAxis(.hidden)
        .chartYScale(domain: .automatic(includesZero: false))
        .frame(height: 140)
        .accessibilityHidden(true)
    }
}
