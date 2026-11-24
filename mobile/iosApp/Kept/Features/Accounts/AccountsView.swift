import SwiftUI

private struct AccountsNewTarget: Identifiable {
    let id = "new"
    let institutionId: String
}

private struct AccountsInstitutionTarget: Identifiable {
    let institution: AccountsPage.Institution?
    var id: String { institution?.id ?? "new" }
}

/// The accounts tab: totals per currency, accounts grouped by institution, archived accounts apart.
struct AccountsView: View {
    @State private var store = PageStore<AccountsPage>(path: "accounts")
    @State private var showArchived = false
    @State private var newAccount: AccountsNewTarget?
    @State private var institutionTarget: AccountsInstitutionTarget?
    @State private var deleting: AccountsPage.Institution?
    @State private var confirmDelete = false
    @Environment(\.session) private var session
    @Environment(\.openURL) private var openURL

    var body: some View {
        PageView("Accounts", store: store) { page in
            content(page)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        newAccount = AccountsNewTarget(institutionId: "")
                    } label: {
                        Label("Add account", systemImage: "plus")
                    }
                    Button {
                        institutionTarget = AccountsInstitutionTarget(institution: nil)
                    } label: {
                        Label("Add institution", systemImage: "building.columns")
                    }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(item: $newAccount) { target in
            AccountFormSheet(
                store: store,
                action: "createAccount",
                institutions: formInstitutions(),
                account: nil,
                defaultInstitutionId: target.institutionId,
                defaultCurrency: session?.preferences.defaultCurrency ?? "CHF"
            )
        }
        .sheet(item: $institutionTarget) { target in
            AccountsInstitutionSheet(store: store, institution: target.institution)
        }
        .confirmationDialog(
            "Delete \(deleting?.name ?? "institution")?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let deleting {
                    var form = FormFields()
                    form.set("id", deleting.id)
                    Task { await store.submit("deleteInstitution", form: form, showRefusal: true) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only institutions without accounts can be deleted. Move or delete its accounts first.")
        }
    }

    private func formInstitutions() -> [AccountFormInstitution] {
        guard let page = store.state.value else { return [] }
        return page.institutions.map { AccountFormInstitution(id: $0.id, name: $0.name) }
    }

    @ViewBuilder
    private func content(_ page: AccountsPage) -> some View {
        if page.accounts.isEmpty && page.institutions.isEmpty {
            welcome
        } else {
            list(page)
        }
    }

    private var welcome: some View {
        ContentUnavailableView {
            Label("Welcome to Kept", systemImage: "building.columns")
        } description: {
            Text("Add an institution and an account, then import your statements.")
        } actions: {
            Button("Add account") { newAccount = AccountsNewTarget(institutionId: "") }
                .buttonStyle(.borderedProminent)
            Button("Add institution") { institutionTarget = AccountsInstitutionTarget(institution: nil) }
        }
    }

    private func list(_ page: AccountsPage) -> some View {
        let archived = AccountsLogic.archivedAccounts(page)
        return List {
            AccountsTotalsSection(totals: AccountsLogic.totals(page), archivedCount: archived.count, showArchived: $showArchived)
            ForEach(AccountsLogic.groups(page)) { group in
                groupSection(group)
            }
            if showArchived && !archived.isEmpty {
                Section("Archived") {
                    ForEach(archived) { account in
                        AccountsRow(account: account)
                    }
                }
            }
        }
    }

    private func groupSection(_ group: AccountsGroup) -> some View {
        Section {
            if group.accounts.isEmpty {
                Text(emptyText(group)).foregroundStyle(.secondary)
            }
            ForEach(group.accounts) { account in
                AccountsRow(account: account)
            }
        } header: {
            groupHeader(group)
        }
    }

    private func emptyText(_ group: AccountsGroup) -> String {
        if let institution = group.institution, institution.accountCount > 0 {
            return "All accounts of this institution are archived."
        }
        return "No accounts yet."
    }

    @ViewBuilder
    private func groupHeader(_ group: AccountsGroup) -> some View {
        HStack {
            Text(group.institution?.name ?? "Other")
            if let bic = group.institution?.bic, !bic.isEmpty {
                Text(bic).font(.caption2).foregroundStyle(.secondary)
            }
            if let institution = group.institution, let url = AccountsLogic.webURL(institution.websiteUrl) {
                Button {
                    openURL(url)
                } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Open \(institution.name) website")
            }
            Spacer()
            if let institution = group.institution {
                institutionMenu(institution)
            }
        }
    }

    private func institutionMenu(_ institution: AccountsPage.Institution) -> some View {
        Menu {
            Button {
                newAccount = AccountsNewTarget(institutionId: institution.id)
            } label: {
                Label("Add account", systemImage: "plus")
            }
            Button {
                institutionTarget = AccountsInstitutionTarget(institution: institution)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = institution
                confirmDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }
}

private struct AccountsTotalsSection: View {
    let totals: [AccountsTotal]
    let archivedCount: Int
    @Binding var showArchived: Bool

    var body: some View {
        if !totals.isEmpty || archivedCount > 0 {
            Section {
                ForEach(totals) { total in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Total \(total.currency)").font(.caption).foregroundStyle(.secondary)
                        AmountText(total.sum, total.currency, tone: .negative)
                            .font(.title2.weight(.semibold))
                        if total.shared {
                            HStack(spacing: 4) {
                                Text("My share")
                                AmountText(total.share, total.currency)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
                if archivedCount > 0 {
                    Toggle("Show archived (\(archivedCount))", isOn: $showArchived)
                }
            } footer: {
                if !totals.isEmpty {
                    Text("Sum of active accounts per currency at full amounts. Currencies are not converted.")
                }
            }
        }
    }
}

/// One account in a list: name, type, balance, top-up IBAN, last booking and a hint when the last import or check is old.
struct AccountsRow: View {
    let account: AccountsPage.Account

    @Environment(\.formats) private var formats
    @Environment(\.session) private var session
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationLink(value: Route.account(account.id)) {
            HStack(alignment: .top, spacing: 12) {
                IconBadge("building.columns", tint: Color(hex: account.institution?.color) ?? .accentColor)
                details
                Spacer(minLength: 8)
                balance
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) { websiteAction }
        .contextMenu { websiteAction }
    }

    @ViewBuilder
    private var websiteAction: some View {
        if let url = AccountsLogic.portalURL(own: account.websiteUrl, institution: account.institution?.websiteUrl) {
            Button {
                openURL(url)
            } label: {
                Label("Website", systemImage: "arrow.up.right.square")
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(account.name).lineLimit(2)
            pills
            if let iban = account.iban, let text = AccountsLogic.displayIban(iban, mode: session?.preferences.ibanDisplay ?? "full") {
                Text(text).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
            }
            topUpLine
            Text(lastBooking).font(.caption).foregroundStyle(.secondary)
            staleLine
        }
    }

    @ViewBuilder
    private var topUpLine: some View {
        let mode = session?.preferences.ibanDisplay ?? "full"
        if account.type != "pillar_3a", let iban = account.depositIban, let text = AccountsLogic.displayIban(iban, mode: mode) {
            HStack(spacing: 4) {
                Text("Top up via")
                Text(text).font(.system(.caption2, design: .monospaced))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private var lastBooking: String {
        if let date = account.lastBookingDate { return "Last booking \(formats.date(date))" }
        return "No transactions yet"
    }

    @ViewBuilder
    private var staleLine: some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if let label = AccountsLogic.staleLabel(lastImportAt: account.lastImportAt, lastCheckedAt: account.lastCheckedAt, now: now) {
            Label(label, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(KeptColor.warning)
        }
    }

    private var pills: some View {
        HStack(spacing: 4) {
            Pill(AccountsLogic.typeLabel(account.type))
            if account.shareBps < AccountsLogic.fullShareBps {
                Pill("Shared \(AccountsLogic.shareText(account.shareBps))")
            }
            if account.archived { Pill("Archived") }
        }
    }

    private var balance: some View {
        VStack(alignment: .trailing, spacing: 2) {
            AmountText(account.balance, account.currency, tone: .negative)
                .font(.headline)
            if account.shareBps < AccountsLogic.fullShareBps {
                HStack(spacing: 3) {
                    Text("Share").font(.caption2)
                    AmountText(account.shareBalance, account.currency).font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
        }
    }
}
