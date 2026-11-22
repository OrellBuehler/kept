import SwiftUI

/// The bills tab: what is overdue and due, payments to confirm, and every bill with search and filter.
struct BillsView: View {
    @State private var store = PageStore<BillsPage>(path: "bills")
    @State private var search = ""
    @State private var appeared = false
    @Environment(Router.self) private var router

    var body: some View {
        PageView("Bills", store: store) { page in
            BillsContent(store: store, page: page)
        }
        .searchable(text: $search, prompt: "Creditor, number, reference, amount")
        .onSubmit(of: .search) {
            applySearch()
        }
        .onChange(of: search) { _, value in
            let current = store.query["q"] ?? ""
            if value.isEmpty, !current.isEmpty { applySearch() }
        }
        .onAppear {
            if appeared {
                Task { await store.load() }
            } else {
                appeared = true
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    router.push(.billNew)
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add bill")
            }
        }
    }

    private func applySearch() {
        let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
        store.query["q"] = text.isEmpty ? nil : text
        store.query["page"] = nil
        Task { await store.load() }
    }
}

private struct BillsContent: View {
    let store: PageStore<BillsPage>
    let page: BillsPage

    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats

    private var filtered: Bool {
        page.query.status != "all" || !page.query.q.isEmpty
    }

    var body: some View {
        List {
            matchingNotices
            suggestionsSection
            if page.counts.total == 0 {
                emptySection
            } else {
                groupsSections
                allSection
            }
        }
    }

    @ViewBuilder
    private var matchingNotices: some View {
        if page.autoMatchPending > 0 {
            Section {
                let count = page.autoMatchPending
                Text(count == 1 ? "1 payment matches a bill's reference exactly." : "\(count) payments match a bill's reference exactly.")
                Button {
                    Task { await matchNow() }
                } label: {
                    Label("Match now", systemImage: "arrow.left.arrow.right")
                }
                .disabled(store.busy)
            }
        }
        if page.matchingFailed {
            Section {
                Label(
                    "Automatic matching could not run, so payment suggestions are missing. Pull down to try again.",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(KeptColor.warning)
            }
        } else if page.suggestionsTruncated {
            Section {
                Label(
                    "Only the most recent transactions were checked for matches. Older payments can be matched from the bill's page.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var suggestionsSection: some View {
        if !page.suggestions.isEmpty {
            Section("Suggestions to confirm (\(page.suggestions.count))") {
                ForEach(page.suggestions) { suggestion in
                    BillSuggestionRow(
                        suggestion: suggestion,
                        showBill: true,
                        busy: store.busy,
                        onConfirm: { Task { await confirm(suggestion) } },
                        onDismiss: { Task { await dismiss(suggestion) } }
                    )
                }
            }
        }
    }

    private var emptySection: some View {
        Section {
            ContentUnavailableView {
                Label("No bills yet", systemImage: "doc.text")
            } description: {
                Text("Upload a QR-bill PDF or add a bill manually. Kept matches payments to bills for you.")
            } actions: {
                Button("Add bill") { router.push(.billNew) }
                    .buttonStyle(.borderedProminent)
            }
            .listRowBackground(Color.clear)
        }
    }

    @ViewBuilder
    private var groupsSections: some View {
        if !filtered, page.query.page == 1 {
            groupSection("Overdue", page.groups.overdue)
            groupSection("Due soon", page.groups.dueSoon)
            groupSection("Awaiting refund", page.groups.awaitingRefund)
        }
    }

    @ViewBuilder
    private func groupSection(_ title: String, _ bills: [BillRecord]) -> some View {
        if !bills.isEmpty {
            Section("\(title) (\(bills.count))") {
                ForEach(bills) { bill in
                    BillRowView(bill: bill)
                }
            }
        }
    }

    private var statusBinding: Binding<String> {
        Binding(
            get: { store.query["status"] ?? page.query.status },
            set: { value in
                store.query["status"] = value == "all" ? nil : value
                store.query["page"] = nil
                Task { await store.load() }
            }
        )
    }

    @ViewBuilder
    private var allSection: some View {
        Section {
            Picker("Status", selection: statusBinding) {
                ForEach(BillText.statusOptions, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
            if page.list.total == 0 {
                Text("No bills match these filters.").foregroundStyle(.secondary)
                if filtered {
                    Button("Clear filter") { clearFilter() }
                }
            }
            ForEach(page.list.items) { bill in
                BillRowView(bill: bill)
            }
        } header: {
            Text("All bills (\(page.list.total))")
        }
        if page.list.pageCount > 1 {
            pagingSection
        }
    }

    private var pagingSection: some View {
        Section {
            HStack {
                Button("Previous") { goToPage(page.list.page - 1) }
                    .disabled(page.list.page <= 1)
                    .buttonStyle(.borderless)
                Spacer()
                VStack(spacing: 2) {
                    Text(BillText.pageRange(page: page.list.page, pageSize: page.list.pageSize, total: page.list.total))
                        .font(.footnote)
                    Text("Page \(page.list.page) of \(page.list.pageCount)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Next") { goToPage(page.list.page + 1) }
                    .disabled(page.list.page >= page.list.pageCount)
                    .buttonStyle(.borderless)
            }
        }
    }

    private func goToPage(_ number: Int) {
        store.query["page"] = number <= 1 ? nil : String(number)
        Task { await store.load() }
    }

    private func clearFilter() {
        store.query["q"] = nil
        store.query["status"] = nil
        store.query["page"] = nil
        Task { await store.load() }
    }

    private func matchNow() async {
        guard let result = await store.submit("matchNow", showRefusal: true) else { return }
        do {
            let answer = try result.decode(BillsMatchResult.self)
            let count = answer.matched ?? 0
            store.message = count == 1 ? "1 payment matched." : "\(count) payments matched."
        } catch {
            store.message = "Payments matched."
        }
    }

    private func confirm(_ suggestion: BillSuggestion) async {
        let form = BillForms.confirm(
            billId: suggestion.bill.id,
            transactionId: suggestion.transaction.id,
            amount: suggestion.amount,
            currency: suggestion.bill.currency
        )
        await store.submit("confirmSuggestion", form: form, showRefusal: true)
    }

    private func dismiss(_ suggestion: BillSuggestion) async {
        let form = BillForms.dismiss(billId: suggestion.bill.id, transactionId: suggestion.transaction.id)
        await store.submit("dismissSuggestion", form: form, showRefusal: true)
    }
}

/// One bill in a list: creditor, due date and hint, amount and status.
struct BillRowView: View {
    let bill: BillRecord

    @Environment(\.formats) private var formats

    var body: some View {
        NavigationLink(value: Route.bill(bill.id)) {
            ValueRow(bill.creditorName ?? "Unnamed creditor", subtitle: subtitle) {
                amountLine
                statusLine
            }
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let number = bill.invoiceNumber, !number.isEmpty { parts.append("No. " + number) }
        if let due = bill.dueDate {
            parts.append("Due " + formats.date(due))
        } else {
            parts.append("No due date")
        }
        if let hint = BillText.dueHint(dueInDays: bill.dueInDays, overdue: bill.overdue, status: bill.status) {
            parts.append(hint)
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    @ViewBuilder
    private var amountLine: some View {
        if let amount = bill.amount {
            AmountText(amount, bill.currency).fontWeight(.semibold)
        } else {
            Text("Open amount").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        if bill.status == "partially_paid", let remaining = bill.remaining {
            HStack(spacing: 4) {
                AmountText(remaining, bill.currency)
                Text("left")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        } else if BillText.refundExpected(status: bill.status) {
            Text("Refund expected").font(.caption).foregroundStyle(.secondary)
        }
        BillStatusPill(status: bill.status, overdue: bill.overdue)
    }
}

/// The status of a bill as a small coloured label.
struct BillStatusPill: View {
    let status: String
    var overdue = false

    var body: some View {
        if overdue {
            Pill("Overdue", color: KeptColor.negative)
        } else {
            Pill(BillText.statusLabel(status), color: color)
        }
    }

    private var color: Color {
        switch status {
        case "paid": return KeptColor.positive
        case "partially_paid": return KeptColor.warning
        case "overpaid": return KeptColor.charts[1]
        case "credit_due": return KeptColor.charts[3]
        default: return .secondary
        }
    }
}

/// A payment the server proposes for a bill, with Confirm and Dismiss.
struct BillSuggestionRow: View {
    let suggestion: BillSuggestion
    let showBill: Bool
    let busy: Bool
    let onConfirm: () -> Void
    let onDismiss: () -> Void

    @Environment(\.formats) private var formats

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            pills
            if showBill { billSide }
            transactionSide
            HStack(spacing: 12) {
                // Not a Label: inside a list row its icon gets the row's icon column
                // (a wide gap before the title) and the row's tint, which is the
                // prominent button's own background.
                Button(action: onConfirm) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark")
                        Text("Confirm")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                Button(action: onDismiss) {
                    HStack(spacing: 4) {
                        Image(systemName: "xmark")
                        Text("Dismiss")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(busy)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private var pills: some View {
        HStack(spacing: 6) {
            Pill(suggestion.rule == "reference" ? "Reference" : "IBAN + amount")
            if suggestion.ambiguous { Pill("Several matches", color: KeptColor.warning) }
            if suggestion.amount < 0 { Pill("Refund", color: KeptColor.charts[3]) }
        }
    }

    private var billSide: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(suggestion.bill.creditorName ?? "Unnamed creditor").fontWeight(.medium)
            if let number = suggestion.bill.invoiceNumber, !number.isEmpty {
                Text("No. " + number).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                if let amount = suggestion.bill.amount {
                    AmountText(amount, suggestion.bill.currency)
                } else {
                    Text("Open amount")
                }
                if let due = suggestion.bill.dueDate { Text("\u{00B7} due " + formats.date(due)) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var transactionSide: some View {
        let tx = suggestion.transaction
        return VStack(alignment: .leading, spacing: 2) {
            HStack {
                Image(systemName: "arrow.left.arrow.right").foregroundStyle(.secondary)
                Text(tx.title).fontWeight(.medium).lineLimit(1)
            }
            Text(tx.accountName + " \u{00B7} " + formats.date(tx.bookingDate))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 4) {
                AmountText(tx.amount, tx.currency, tone: .signed)
                if suggestion.amount != abs(tx.amount) || suggestion.amount < 0 {
                    Text("\u{00B7} applies")
                    AmountText(suggestion.amount, suggestion.bill.currency)
                }
            }
            .font(.caption)
        }
    }
}
