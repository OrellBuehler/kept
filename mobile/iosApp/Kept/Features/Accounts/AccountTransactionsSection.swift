import SwiftUI

/// The transactions of the account (filtered and paged by the page's query) and the way to add one.
struct AccountTransactionsSection: View {
    let store: PageStore<AccountPage>
    let page: AccountPage
    @Binding var sheet: AccountDetailSheet?
    @Binding var confirm: AccountDetailConfirm?
    let onPage: (Int) -> Void
    let onClearFilters: () -> Void

    var body: some View {
        Section {
            summary
            if page.transactions.items.isEmpty {
                emptyState
            } else {
                rows
                if page.transactions.pageCount > 1 { pager }
            }
        } header: {
            header
        }
    }

    private var header: some View {
        HStack {
            Text("Transactions")
            Spacer()
            Button {
                sheet = .filters
            } label: {
                Image(systemName: page.filters.isActive
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle")
            }
            .accessibilityLabel("Filters")
            Button {
                sheet = .addTransaction
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("Add transaction")
        }
    }

    private var summary: some View {
        let total = page.transactions.total
        let noun = total == 1 ? "transaction" : "transactions"
        let suffix = page.filters.isActive ? " match the filters" : ""
        return HStack {
            Text("\(total) \(noun)\(suffix)").font(.footnote).foregroundStyle(.secondary)
            Spacer()
            if page.filters.isActive {
                Button("Clear", action: onClearFilters).font(.footnote).buttonStyle(.borderless)
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if page.filters.isActive {
            Text("Nothing matches these filters. Try a wider range or clear them.").foregroundStyle(.secondary)
        } else {
            Text("No transactions yet. Import a statement, or add a transaction by hand.").foregroundStyle(.secondary)
            Button("Add transaction") { sheet = .addTransaction }
        }
    }

    private var rows: some View {
        ForEach(page.transactions.items) { transaction in
            row(transaction)
        }
    }

    private func row(_ transaction: AccountPage.Tx) -> some View {
        Button {
            sheet = .transaction(transaction.id)
        } label: {
            AccountDetailTxRow(
                transaction: transaction,
                category: page.category(withId: transaction.categoryId),
                currency: page.account.currency,
                shareBps: page.account.shareBps
            )
        }
        .tint(.primary)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if transaction.source != "import" {
                Button(role: .destructive) {
                    confirm = deleteConfirm(transaction)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    private func deleteConfirm(_ transaction: AccountPage.Tx) -> AccountDetailConfirm {
        let mirror = transaction.source == "mirror"
        return AccountDetailConfirm(
            action: "deleteTransaction",
            field: "transactionId",
            targetId: transaction.id,
            title: mirror ? "Remove this mirror?" : "Delete this transaction?",
            message: AccountTransactionSheet.deleteMessage(mirror: mirror),
            button: mirror ? "Remove mirror" : "Delete"
        )
    }

    private var pager: some View {
        HStack {
            Button("Previous") { onPage(page.transactions.page - 1) }
                .disabled(page.transactions.page <= 1)
            Spacer()
            Text("Page \(page.transactions.page) of \(page.transactions.pageCount)")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Next") { onPage(page.transactions.page + 1) }
                .disabled(page.transactions.page >= page.transactions.pageCount)
        }
        .buttonStyle(.borderless)
    }
}

/// One transaction row: counterparty or description, date, category, amount.
struct AccountDetailTxRow: View {
    let transaction: AccountPage.Tx
    let category: AccountPage.Category?
    let currency: String
    let shareBps: Int

    @Environment(\.formats) private var formats

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(AccountsLogic.title(transaction)).lineLimit(2)
                if let subtitle = AccountsLogic.subtitle(transaction) {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(formats.date(transaction.bookingDate)).font(.caption).foregroundStyle(.secondary)
                if let category {
                    categoryLine(category)
                }
                badges
            }
            Spacer(minLength: 8)
            amounts
        }
    }

    private func categoryLine(_ category: AccountPage.Category) -> some View {
        HStack(spacing: 4) {
            Circle().fill(Color(hex: category.color) ?? Color.secondary).frame(width: 8, height: 8)
            Text(category.name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    @ViewBuilder
    private var badges: some View {
        let mirror = transaction.source == "mirror"
        let manual = transaction.source == "manual"
        let hasNote = !(transaction.note ?? "").isEmpty
        let needsAmount = transaction.transfer?.status == "needs_amount"
        if mirror || manual || transaction.transfer != nil || hasNote {
            HStack(spacing: 4) {
                if mirror { Pill("mirrored") }
                if manual { Pill("manual") }
                if let transfer = transaction.transfer {
                    Pill(AccountsLogic.transferLabel(transfer))
                }
                if needsAmount { Pill("needs amount", color: KeptColor.warning) }
                if hasNote {
                    Image(systemName: "note.text").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var amounts: some View {
        VStack(alignment: .trailing, spacing: 2) {
            AmountText(transaction.amount, currency, tone: .signed, showPlus: true)
                .fontWeight(.medium)
            if shareBps < AccountsLogic.fullShareBps {
                HStack(spacing: 3) {
                    Text("Share").font(.caption2)
                    AmountText(AccountsLogic.shareOf(transaction.amount, shareBps), currency, tone: .signed)
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
        }
    }
}

/// Date range and amount range of the transaction list ("from", "to", "min", "max" of the page's query).
struct AccountFiltersSheet: View {
    let store: PageStore<AccountPage>
    let filters: AccountPage.Filters
    let onApply: ([String: String]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var from: String
    @State private var to: String
    @State private var minAmount: String
    @State private var maxAmount: String

    init(store: PageStore<AccountPage>, filters: AccountPage.Filters, onApply: @escaping ([String: String]) -> Void) {
        self.store = store
        self.filters = filters
        self.onApply = onApply
        _from = State(initialValue: filters.from)
        _to = State(initialValue: filters.to)
        _minAmount = State(initialValue: filters.min)
        _maxAmount = State(initialValue: filters.max)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Booking date") {
                    DateField("From", value: $from, optional: true)
                    FieldError(errorText("from"))
                    DateField("To", value: $to, optional: true)
                    FieldError(errorText("to"))
                }
                Section("Amount") {
                    AmountField("Minimum, e.g. -100.00", text: $minAmount)
                    FieldError(errorText("min"))
                    AmountField("Maximum, e.g. 500.00", text: $maxAmount)
                    FieldError(errorText("max"))
                }
                Section {
                    Button("Clear all filters", role: .destructive) {
                        onApply(["q": "", "from": "", "to": "", "min": "", "max": ""])
                        dismiss()
                    }
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        onApply(["from": from, "to": to, "min": minAmount, "max": maxAmount])
                        dismiss()
                    }
                }
            }
        }
    }

    private func errorText(_ key: String) -> String? {
        let page = store.state.value
        return page?.filterErrors[key]?.first
    }
}
