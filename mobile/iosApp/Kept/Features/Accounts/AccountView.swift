import SwiftUI

/// What the account screen presents in its one sheet.
enum AccountDetailSheet: Identifiable {
    case editAccount
    case deleteAccount
    case addTransaction
    case filters
    case transaction(String)
    case addSnapshot
    case addTrade
    case editTrade(String)
    case addPortfolio
    case editPortfolio(String)
    case closePortfolio(String)
    case portfolioValues
    case portfolioHistory(String)

    var id: String {
        switch self {
        case .editAccount: return "editAccount"
        case .deleteAccount: return "deleteAccount"
        case .addTransaction: return "addTransaction"
        case .filters: return "filters"
        case let .transaction(id): return "transaction:" + id
        case .addSnapshot: return "addSnapshot"
        case .addTrade: return "addTrade"
        case let .editTrade(id): return "editTrade:" + id
        case .addPortfolio: return "addPortfolio"
        case let .editPortfolio(id): return "editPortfolio:" + id
        case let .closePortfolio(id): return "closePortfolio:" + id
        case .portfolioValues: return "portfolioValues"
        case let .portfolioHistory(id): return "portfolioHistory:" + id
        }
    }
}

/// A destructive action that asks first: one form field (`field` = `targetId`) sent to `action`.
struct AccountDetailConfirm {
    let action: String
    let field: String
    let targetId: String
    let title: String
    let message: String
    let button: String
}

/// One account: header, transactions, holdings, portfolios and balance snapshots.
struct AccountView: View {
    let id: String
    @State private var store: PageStore<AccountPage>

    init(id: String) {
        self.id = id
        _store = State(initialValue: PageStore<AccountPage>(path: "accounts/\(id)"))
    }

    var body: some View {
        PageView("Account", store: store) { page in
            AccountDetailBody(store: store, page: page)
        }
    }
}

/// The list of the account screen and the one sheet and confirmation dialog its sections open.
struct AccountDetailBody: View {
    let store: PageStore<AccountPage>
    let page: AccountPage

    @Environment(Router.self) private var router
    @Environment(\.session) private var session
    @State private var sheet: AccountDetailSheet?
    @State private var confirm: AccountDetailConfirm?
    @State private var search = ""

    var body: some View {
        list
            .searchable(text: $search, prompt: "Search transactions")
            .onSubmit(of: .search) { applyQuery(["q": search]) }
            .onChange(of: search) { _, value in
                let current = store.query["q"] ?? ""
                if value.isEmpty && !current.isEmpty { applyQuery(["q": ""]) }
            }
            .toolbar { toolbar }
            .sheet(item: $sheet) { item in
                sheetContent(item)
            }
            .confirmationDialog(
                confirm?.title ?? "Are you sure?",
                isPresented: confirmBinding,
                titleVisibility: .visible
            ) {
                confirmActions
            } message: {
                Text(confirm?.message ?? "")
            }
    }

    private var list: some View {
        List {
            AccountDetailHeader(page: page)
            banners
            AccountTransactionsSection(
                store: store,
                page: page,
                sheet: $sheet,
                confirm: $confirm,
                onPage: { number in
                    store.query["page"] = number <= 1 ? nil : String(number)
                    Task { await store.load() }
                },
                onClearFilters: { applyQuery(["q": "", "from": "", "to": "", "min": "", "max": ""]) }
            )
            investmentSections
            AccountSnapshotsSection(page: page, sheet: $sheet, confirm: $confirm)
        }
    }

    @ViewBuilder
    private var banners: some View {
        if let suggestion = page.transfers.fillSuggestion, !page.account.fillFromTransfers, !page.account.archived {
            AccountFillBanner(store: store, count: suggestion.count)
        }
        if !page.transfers.needsAmount.isEmpty {
            AccountNeedsAmountSection(store: store, items: page.transfers.needsAmount)
        }
    }

    @ViewBuilder
    private var investmentSections: some View {
        if page.hasHoldings, let valuation = page.value {
            AccountHoldingsSection(page: page, valuation: valuation, sheet: $sheet, confirm: $confirm)
        }
        if page.showPortfolios {
            AccountPortfoliosSection(store: store, page: page, sheet: $sheet, confirm: $confirm)
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button {
                    sheet = .editAccount
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button {
                    router.push(.importFiles)
                } label: {
                    Label("Import statement", systemImage: "square.and.arrow.down")
                }
                Button {
                    router.push(.accountImports(page.account.id))
                } label: {
                    Label("Import history", systemImage: "clock")
                }
                if page.account.lastImportAt != nil && !page.account.archived {
                    Button {
                        Task { await markChecked() }
                    } label: {
                        Label("No new transactions", systemImage: "checkmark.circle")
                    }
                }
                Button {
                    Task { await toggleArchive() }
                } label: {
                    Label(page.account.archived ? "Unarchive" : "Archive", systemImage: "archivebox")
                }
                Button(role: .destructive) {
                    sheet = .deleteAccount
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    private func toggleArchive() async {
        let action = page.account.archived ? "unarchive" : "archive"
        await store.submit(action, showRefusal: true)
    }

    private func markChecked() async {
        let result = await store.submit("markChecked", showRefusal: true)
        if result != nil { store.message = "Marked as up to date" }
    }

    private func applyQuery(_ changes: [String: String]) {
        for (key, value) in changes {
            store.query[key] = value.isEmpty ? nil : value
        }
        store.query["page"] = nil
        if changes["q"] == "" { search = "" }
        Task { await store.load() }
    }

    private var confirmBinding: Binding<Bool> {
        Binding(
            get: { confirm != nil },
            set: { shown in
                if !shown { confirm = nil }
            }
        )
    }

    @ViewBuilder
    private var confirmActions: some View {
        if let item = confirm {
            Button(item.button, role: .destructive) {
                Task { await run(item) }
            }
        }
        Button("Cancel", role: .cancel) {}
    }

    private func run(_ item: AccountDetailConfirm) async {
        var form = FormFields()
        form.set(item.field, item.targetId)
        await store.submit(item.action, form: form, showRefusal: true)
    }

    @ViewBuilder
    private func sheetContent(_ item: AccountDetailSheet) -> some View {
        switch item {
        case .editAccount: editAccountSheet
        case .deleteAccount: AccountDeleteSheet(store: store, account: page.account)
        case .addTransaction: AccountTransactionFormSheet(store: store, account: page.account, transaction: nil)
        case .filters: AccountFiltersSheet(store: store, filters: page.filters, onApply: { changes in applyQuery(changes) })
        case let .transaction(id): AccountTransactionSheet(store: store, transactionId: id)
        case .addSnapshot: AccountSnapshotSheet(store: store, account: page.account)
        case .addTrade: AccountTradeSheet(store: store, page: page, trade: nil)
        case let .editTrade(id): AccountTradeSheet(store: store, page: page, trade: page.trades.first(where: { $0.id == id }))
        case .addPortfolio: AccountPortfolioSheet(store: store, portfolio: nil, qrIban: portfolioQrIban)
        case let .editPortfolio(id):
            AccountPortfolioSheet(
                store: store,
                portfolio: page.portfolios.first(where: { $0.id == id }),
                qrIban: portfolioQrIban
            )
        case let .closePortfolio(id): AccountPortfolioCloseSheet(store: store, portfolio: page.portfolios.first(where: { $0.id == id }))
        case .portfolioValues: AccountPortfolioValuesSheet(store: store, page: page)
        case let .portfolioHistory(id): AccountPortfolioHistorySheet(store: store, page: page, portfolioId: id)
        }
    }

    private var portfolioQrIban: Bool {
        guard let deposit = page.account.depositIban else { return false }
        return AccountsLogic.isQrIban(deposit)
    }

    private var editAccountSheet: some View {
        let mirrorCount: Int? = page.transfers.mirrorCount
        let locked = page.account.lastBookingDate != nil
            || page.account.openingBalance != 0
            || !page.snapshots.isEmpty
            || !page.trades.isEmpty
            || page.portfolios.contains(where: { $0.latestValue != nil })
        return AccountFormSheet(
            store: store,
            action: "updateAccount",
            institutions: page.institutions.map { AccountFormInstitution(id: $0.id, name: $0.name) },
            account: page.account,
            defaultCurrency: session?.preferences.defaultCurrency ?? "CHF",
            currencyLocked: locked,
            mirrorCount: mirrorCount,
            hasPortfolios: !page.portfolios.isEmpty,
            hasTrades: !page.trades.isEmpty
        )
    }
}
