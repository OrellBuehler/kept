import SwiftUI

/// Subscriptions, rent, salary and other payments that repeat, detected from the transactions.
struct RecurringView: View {
    @State private var store = PageStore<RecurringPage>(path: "recurring")
    @State private var editing: RecurringPage.Series?

    var body: some View {
        PageView("Recurring", store: store) { page in
            content(page)
        }
        .sheet(item: $editing) { series in
            RecurringEditSheet(store: store, series: series)
        }
    }

    @ViewBuilder
    private func content(_ page: RecurringPage) -> some View {
        List {
            if page.series.isEmpty {
                emptyState
            } else {
                ForEach(page.totals) { total in
                    totalSection(total)
                }
                group("To review", "Confirm the ones that are real; dismissed ones are not suggested again.", page, "suggested")
                group("Confirmed", nil, page, "confirmed")
                group("Dismissed", nil, page, "dismissed")
            }
        }
    }

    private var emptyState: some View {
        Section {
            ContentUnavailableView {
                Label("No recurring payments found", systemImage: "repeat")
            } description: {
                Text("Import a few months of transactions. Payments to the same counterparty at a regular interval show up here.")
            }
        }
    }

    private func totalSection(_ total: RecurringPage.Total) -> some View {
        Section {
            LabeledContent("Monthly") { AmountText(total.outflowMonthly, total.currency) }
            LabeledContent("Annual") { AmountText(total.outflowAnnual, total.currency) }
            if total.inflowAnnual > 0 {
                LabeledContent("Recurring income, annual") { AmountText(total.inflowAnnual, total.currency) }
            }
        } header: {
            Text(total.currency)
        } footer: {
            Text("Confirmed recurring payments")
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ note: String?, _ page: RecurringPage, _ status: String) -> some View {
        let items = RecurringLogic.series(page.series, status: status)
        if !items.isEmpty {
            Section {
                ForEach(items) { series in
                    seriesRow(series)
                }
            } header: {
                Text(title)
            } footer: {
                if let note { Text(note) }
            }
        }
    }

    private func seriesRow(_ series: RecurringPage.Series) -> some View {
        Button {
            editing = series
        } label: {
            RecurringRow(series: series)
        }
        .tint(.primary)
        .swipeActions(edge: .trailing) {
            if series.status == "dismissed" {
                actionButton("Restore", "restore", "arrow.uturn.backward", series)
            } else {
                actionButton("Dismiss", "dismiss", "xmark", series)
            }
        }
        .swipeActions(edge: .leading) {
            if series.status == "suggested" {
                actionButton("Confirm", "confirm", "checkmark", series)
            }
        }
        .contextMenu {
            if series.status == "suggested" {
                actionButton("Confirm", "confirm", "checkmark", series)
            }
            if series.status == "dismissed" {
                actionButton("Restore", "restore", "arrow.uturn.backward", series)
            } else {
                actionButton("Dismiss", "dismiss", "xmark", series)
            }
            Button {
                editing = series
            } label: {
                Label("Edit", systemImage: "pencil")
            }
        }
    }

    private func actionButton(_ title: String, _ action: String, _ image: String, _ series: RecurringPage.Series) -> some View {
        Button {
            Task { await run(action, series) }
        } label: {
            Label(title, systemImage: image)
        }
    }

    private func run(_ action: String, _ series: RecurringPage.Series) async {
        var form = FormFields()
        form.set("id", series.id)
        await store.submit(action, form: form, showRefusal: true)
    }
}

/// One detected series: name, interval, next date, amount and cost per year.
struct RecurringRow: View {
    let series: RecurringPage.Series
    @Environment(\.formats) private var formats

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(series.name).lineLimit(2)
                    pills
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    AmountText(series.amount, series.currency, tone: .signed)
                    Text(yearText).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(detail).font(.caption).foregroundStyle(.secondary)
            if let change = series.priceChange {
                Text(priceText(change)).font(.caption).foregroundStyle(KeptColor.negative)
            }
        }
        .padding(.vertical, 2)
    }

    private var pills: some View {
        HStack(spacing: 6) {
            Pill(RecurringLogic.cadenceLabel(series.cadence))
            if series.priceChange != nil { Pill("Price changed", color: KeptColor.negative) }
            if series.overdue && series.status == "confirmed" { Pill("Overdue", color: KeptColor.warning) }
        }
    }

    private var detail: String {
        let last = formats.date(series.lastDate)
        let next = formats.date(series.nextExpected)
        return "Last seen \(last) · next expected \(next) · \(series.occurrences) payments"
    }

    private var yearText: String {
        let cost = formats.hideAmounts ? "\(series.currency) •••" : formats.money(series.annualCost, series.currency)
        return cost + " per year"
    }

    private func priceText(_ change: RecurringPage.PriceChange) -> String {
        let previous = formats.hideAmounts ? "•••" : formats.money(change.previous, series.currency)
        let latest = formats.hideAmounts ? "•••" : formats.money(change.latest, series.currency)
        return "Price changed " + previous + " → " + latest
    }
}

/// Edits the name, interval and amount of a series.
struct RecurringEditSheet: View {
    let store: PageStore<RecurringPage>
    let series: RecurringPage.Series

    @State private var name: String
    @State private var cadence: String
    @State private var amount: String

    init(store: PageStore<RecurringPage>, series: RecurringPage.Series) {
        self.store = store
        self.series = series
        _name = State(initialValue: series.name)
        _cadence = State(initialValue: series.cadence)
        _amount = State(initialValue: RecurringLogic.amountText(series.amount, series.currency))
    }

    var body: some View {
        FormSheet(
            "Edit recurring payment",
            busy: store.busy,
            error: store.formErrors["form"],
            onSubmit: { await save() },
            content: { fields }
        )
    }

    @ViewBuilder
    private var fields: some View {
        Section {
            TextField("Name", text: $name)
            FieldError(store.formErrors["name"])
            Picker("Repeats", selection: $cadence) {
                ForEach(RecurringLogic.cadences, id: \.self) { value in
                    Text(RecurringLogic.cadenceLabel(value)).tag(value)
                }
            }
            FieldError(store.formErrors["cadence"])
            AmountField("Amount", text: $amount, currency: series.currency)
            FieldError(store.formErrors["amount"])
        } footer: {
            Text("Your changes are kept when the transactions are scanned again.")
        }
    }

    private func save() async -> Bool {
        var form = FormFields()
        form.set("id", series.id)
        form.set("name", name)
        form.set("cadence", cadence)
        form.set("amount", amount)
        let result = await store.submit("edit", form: form)
        return result != nil
    }
}
