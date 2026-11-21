import Charts
import SwiftUI

/// What the planned item form edits: a new item (`item` nil) or an existing one.
struct ForecastPlannedEditor: Identifiable {
    let id = UUID()
    let item: ForecastPage.Planned?
}

/// The account whose forecast settings are edited.
struct ForecastSettingsTarget: Identifiable {
    let id: String
    let name: String
    let currency: String
    let threshold: Int64?
    let defaultPayment: Bool
}

/// Expected balances per account for the next 30, 60 or 90 days.
struct ForecastView: View {
    @State private var store = PageStore<ForecastPage>(path: "forecast")
    @State private var plannedEditor: ForecastPlannedEditor?
    @State private var settingsTarget: ForecastSettingsTarget?
    @State private var deleting: ForecastPage.Planned?
    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats

    var body: some View {
        PageView("Forecast", store: store) { page in
            content(page)
        }
        .toolbar { toolbar }
        .sheet(item: $plannedEditor) { editor in
            plannedSheet(editor)
        }
        .sheet(item: $settingsTarget) { target in
            ForecastSettingsSheet(store: store, target: target)
        }
        .confirmationDialog(
            "Delete this planned item?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { item in
            Button("Delete", role: .destructive) { Task { await delete(item) } }
        } message: { item in
            Text("\(item.label) is removed. Your accounts and bills are not affected.")
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                plannedEditor = ForecastPlannedEditor(item: nil)
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("Add planned item")
            .disabled(store.state.value == nil)
        }
    }

    @ViewBuilder
    private func content(_ page: ForecastPage) -> some View {
        List {
            horizonSection(page)
            if page.forecast.accounts.isEmpty {
                emptyState
            } else {
                warningsSection(page.forecast.accounts)
                ForEach(page.forecast.accounts) { account in
                    accountSection(account, page: page)
                }
                unassignedSection(page.forecast.unassigned)
                itemsSection(page)
            }
            plannedSection(page)
        }
    }

    private func horizonSection(_ page: ForecastPage) -> some View {
        let selection = Binding<Int>(
            get: { page.days },
            set: { value in
                store.query["days"] = String(value)
                Task { await store.load() }
            }
        )
        let note = "Expected balances until \(formats.date(page.forecast.to)), per account and currency."
        return Section {
            Picker("Horizon", selection: selection) {
                ForEach(page.horizons, id: \.self) { days in
                    Text("\(days) days").tag(days)
                }
            }
            .pickerStyle(.segmented)
        } footer: {
            Text(note)
        }
    }

    private var emptyState: some View {
        Section {
            ContentUnavailableView {
                Label("No accounts to forecast", systemImage: "chart.line.uptrend.xyaxis")
            } description: {
                Text("Add an account and its bills, then the forecast shows how your balance develops.")
            } actions: {
                Button("Go to accounts") { router.tab = .accounts }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    @ViewBuilder
    private func warningsSection(_ accounts: [ForecastPage.Account]) -> some View {
        let warned = ForecastLogic.warnings(accounts)
        if !warned.isEmpty {
            Section("Low balance ahead") {
                ForEach(warned) { account in
                    warningRow(account)
                }
            }
        }
    }

    @ViewBuilder
    private func warningRow(_ account: ForecastPage.Account) -> some View {
        if let warning = account.warning {
            let title = warning.negative ? "\(account.name) goes below zero" : "\(account.name) falls below its limit"
            let detail = warningDetail(warning, currency: account.currency)
            ValueRow(title, subtitle: detail, systemImage: "exclamationmark.triangle", tint: KeptColor.negative)
        }
    }

    private func warningDetail(_ warning: ForecastPage.Warning, currency: String) -> String {
        let date = formats.date(warning.date)
        let balance = money(warning.balance, currency)
        if warning.negative {
            return "On \(date), to \(balance)."
        }
        return "Limit \(money(warning.limit, currency)). On \(date), to \(balance)."
    }

    private func money(_ minor: Int64, _ currency: String) -> String {
        formats.hideAmounts ? "\(currency) •••" : formats.money(minor, currency)
    }

    @ViewBuilder
    private func accountSection(_ account: ForecastPage.Account, page: ForecastPage) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                accountSummary(account, to: page.forecast.to)
                if account.points.count >= 2 {
                    ForecastChart(points: account.points)
                }
            }
            .padding(.vertical, 4)
        } header: {
            HStack {
                Text(account.name)
                Spacer()
                Button {
                    settingsTarget = makeSettingsTarget(for: account, page: page)
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Forecast settings for \(account.name)")
            }
        }
    }

    @ViewBuilder
    private func accountSummary(_ account: ForecastPage.Account, to: String) -> some View {
        if account.hasBalance {
            LabeledContent("Now") { AmountText(account.startBalance, account.currency, tone: .negative) }
            LabeledContent("On \(formats.date(to))") {
                AmountText(account.endBalance, account.currency, tone: .negative)
            }
            LabeledContent("Lowest, \(formats.date(account.lowest.date))") {
                AmountText(account.lowest.balance, account.currency, tone: .negative)
            }
        } else {
            Text("No balance data yet. The chart shows the change from zero.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            LabeledContent("On \(formats.date(to))") {
                AmountText(account.endBalance, account.currency, tone: .negative)
            }
        }
    }

    private func makeSettingsTarget(for account: ForecastPage.Account, page: ForecastPage) -> ForecastSettingsTarget {
        var threshold: Int64?
        var defaultPayment = false
        for setting in page.settings where setting.accountId == account.accountId {
            threshold = setting.threshold
            defaultPayment = setting.defaultPayment
        }
        return ForecastSettingsTarget(
            id: account.accountId,
            name: account.name,
            currency: account.currency,
            threshold: threshold,
            defaultPayment: defaultPayment
        )
    }

    @ViewBuilder
    private func unassignedSection(_ unassigned: [ForecastPage.Unassigned]) -> some View {
        if !unassigned.isEmpty {
            Section {
                ForEach(unassigned) { entry in
                    unassignedRow(entry)
                }
            } header: {
                Text("Not assigned to an account")
            } footer: {
                Text("These items are not in any chart. Set a paying account on the bill or a default payment account in the account's forecast settings.")
            }
        }
    }

    private func unassignedRow(_ entry: ForecastPage.Unassigned) -> some View {
        let count = entry.count == 1 ? "1 item" : "\(entry.count) items"
        return ValueRow(entry.currency, subtitle: count) {
            AmountText(entry.outflow, entry.currency, tone: .signed)
            if entry.inflow != 0 {
                AmountText(entry.inflow, entry.currency, tone: .signed, showPlus: true)
            }
        }
    }

    private func itemsSection(_ page: ForecastPage) -> some View {
        let skipped = page.forecast.unprojectedBills.noDueDate + page.forecast.unprojectedBills.noAmount
        let items = page.forecast.items
        return Section {
            if items.isEmpty {
                Text("Nothing expected in this period.").foregroundStyle(.secondary)
            }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                itemRow(item, accounts: page.forecast.accounts)
            }
        } header: {
            Text("Upcoming items")
        } footer: {
            Text(itemsFooter(days: page.days, skipped: skipped))
        }
    }

    private func itemsFooter(days: Int, skipped: Int) -> String {
        var text = "Open bills and planned items in the next \(days) days. Overdue bills count on today."
        if skipped == 1 {
            text += " 1 unpaid bill is left out because it has no due date or no amount."
        } else if skipped > 1 {
            text += " \(skipped) unpaid bills are left out because they have no due date or no amount."
        }
        return text
    }

    private func itemRow(_ item: ForecastPage.Item, accounts: [ForecastPage.Account]) -> some View {
        let accountName = ForecastLogic.accountName(item.accountId, in: accounts)
        let subtitle = formats.date(item.date) + " · " + accountName
        return ValueRow(item.label, subtitle: subtitle) {
            AmountText(item.amount, item.currency, tone: .signed)
            Pill(ForecastLogic.sourceLabel(item.source))
        }
    }

    private func plannedSection(_ page: ForecastPage) -> some View {
        Section {
            if page.planned.isEmpty {
                Text("None yet. Add a salary or a tax installment to see its effect.").foregroundStyle(.secondary)
            }
            ForEach(page.planned) { item in
                plannedRow(item, accounts: page.forecast.accounts)
            }
        } header: {
            Text("Planned items")
        } footer: {
            Text("One-off income and expenses you add yourself.")
        }
    }

    private func plannedRow(_ item: ForecastPage.Planned, accounts: [ForecastPage.Account]) -> some View {
        let subtitle = formats.date(item.date) + " · " + ForecastLogic.accountName(item.accountId, in: accounts)
        return Button {
            plannedEditor = ForecastPlannedEditor(item: item)
        } label: {
            ValueRow(item.label, subtitle: subtitle) {
                AmountText(item.amount, item.currency, tone: .signed)
            }
        }
        .tint(.primary)
        .swipeActions {
            Button(role: .destructive) {
                deleting = item
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .contextMenu {
            Button {
                plannedEditor = ForecastPlannedEditor(item: item)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = item
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private func plannedSheet(_ editor: ForecastPlannedEditor) -> some View {
        let page = store.state.value
        ForecastPlannedSheet(
            store: store,
            item: editor.item,
            today: page?.today ?? "",
            accounts: page?.forecast.accounts ?? []
        )
    }

    private func delete(_ item: ForecastPage.Planned) async {
        var form = FormFields()
        form.set("id", item.id)
        await store.submit("deletePlanned", form: form, showRefusal: true)
    }
}

/// The projected balance of one account as a line.
private struct ForecastChart: View {
    let points: [ForecastPage.Point]

    private struct Sample: Identifiable {
        let date: Date
        let amount: Double
        var id: Date { date }
    }

    private var data: [Sample] {
        points.compactMap { point in
            Formats.parseDate(point.date).map { Sample(date: $0, amount: Double(point.balance) / 100) }
        }
    }

    var body: some View {
        let data = data
        Chart(data) { item in
            LineMark(x: .value("Date", item.date), y: .value("Balance", item.amount))
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
        .chartYAxis(.hidden)
        .chartYScale(domain: .automatic(includesZero: false))
        .frame(height: 120)
        .accessibilityHidden(true)
    }
}
