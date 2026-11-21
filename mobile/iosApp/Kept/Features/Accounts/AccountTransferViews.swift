import SwiftUI

/// The transfer of a transaction: where it goes, unlink, or link it to a transaction of another account.
struct AccountTransferSection: View {
    let store: PageStore<AccountPage>
    let transaction: AccountPage.Tx
    let onOpenAccount: (String) -> Void

    private enum Phase {
        case idle
        case loading
        case loaded([AccountTransferCandidates.Candidate])
        case failed(String)
    }

    @Environment(\.formats) private var formats
    @State private var phase: Phase = .idle
    @State private var confirmUnlink = false

    private var isMirror: Bool { transaction.source == "mirror" }

    var body: some View {
        Section {
            if let transfer = transaction.transfer {
                linked(transfer)
            } else if !isMirror {
                unlinked
            } else {
                Text("This mirrored transaction has no source any more.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Transfer")
        }
    }

    // MARK: Linked

    @ViewBuilder
    private func linked(_ transfer: AccountPage.Tx.TransferLink) -> some View {
        Button {
            onOpenAccount(transfer.peerAccountId)
        } label: {
            HStack {
                Text(AccountsLogic.transferLabel(transfer))
                if transfer.status == "needs_amount" { Pill("needs amount", color: KeptColor.warning) }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
            }
        }
        .tint(.primary)
        Text(explanation(transfer)).font(.footnote).foregroundStyle(.secondary)
        if !isMirror {
            Button("Unlink transfer", role: .destructive) { confirmUnlink = true }
                .confirmationDialog("Unlink this transfer?", isPresented: $confirmUnlink, titleVisibility: .visible) {
                    Button("Unlink transfer", role: .destructive) {
                        Task { await unlink() }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The two transactions count as income and expense again.")
                }
        }
    }

    private func explanation(_ transfer: AccountPage.Tx.TransferLink) -> String {
        if transfer.status == "needs_amount" {
            return "The other account is in another currency. Enter the amount it booked in the needs amount list on that account."
        }
        if transfer.method == "mirrored" {
            return isMirror
                ? "Kept created this transaction from the transfer on that account."
                : "Kept created the other side on that account."
        }
        if transfer.method == "manual" {
            return "Linked by hand. It does not count as income or expense."
        }
        return "Matched with a transaction on that account. It does not count as income or expense."
    }

    private func unlink() async {
        var form = FormFields()
        form.set("transactionId", transaction.id)
        await store.submit("unlinkTransfer", form: form, showRefusal: true)
    }

    // MARK: Not linked

    @ViewBuilder
    private var unlinked: some View {
        Text("Not linked. If this is a payment between two of your accounts, link it to the other side so it does not count as income or expense.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        switch phase {
        case .idle:
            Button {
                Task { await loadCandidates() }
            } label: {
                Label("Link as transfer", systemImage: "link")
            }
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Looking for matches").foregroundStyle(.secondary)
            }
        case let .failed(message):
            Text(message).foregroundStyle(KeptColor.negative)
            Button("Try again") { Task { await loadCandidates() } }
        case let .loaded(candidates):
            candidateList(candidates)
        }
    }

    @ViewBuilder
    private func candidateList(_ candidates: [AccountTransferCandidates.Candidate]) -> some View {
        if candidates.isEmpty {
            Text("No transaction in your other accounts is within ten days with the opposite sign and is not already linked.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Text("Pick the other side").font(.subheadline.weight(.medium))
            ForEach(candidates) { candidate in
                Button {
                    Task { await link(candidate) }
                } label: {
                    candidateRow(candidate)
                }
                .tint(.primary)
                .disabled(store.busy)
            }
        }
        Button("Cancel") { phase = .idle }
    }

    private func candidateRow(_ candidate: AccountTransferCandidates.Candidate) -> some View {
        let detail = candidate.counterpartyName ?? candidate.description ?? ""
        let when = formats.date(candidate.bookingDate) + " \u{00B7} " + AccountsLogic.daysApartText(candidate.days)
        return ValueRow(candidate.accountName, subtitle: detail.isEmpty ? when : detail + "\n" + when) {
            AmountText(candidate.amount, candidate.currency, tone: .signed, showPlus: true)
            if candidate.exact { Pill("same amount") }
        }
    }

    private func loadCandidates() async {
        phase = .loading
        var form = FormFields()
        form.set("transactionId", transaction.id)
        let result = await store.submit("transferCandidates", form: form, reload: false)
        guard let result else {
            phase = .failed("Could not look for matches.")
            return
        }
        do {
            let decoded = try result.decode(AccountTransferCandidates.self)
            phase = .loaded(decoded.candidates)
        } catch {
            phase = .failed("The server answered something this app does not understand.")
        }
    }

    private func link(_ candidate: AccountTransferCandidates.Candidate) async {
        var form = FormFields()
        form.set("transactionId", transaction.id)
        form.set("peerId", candidate.id)
        let result = await store.submit("linkTransfer", form: form, showRefusal: true)
        if result == nil { phase = .idle }
    }
}

/// "Fill this account from transfers?": offered for an account that was never imported into.
struct AccountFillBanner: View {
    let store: PageStore<AccountPage>
    let count: Int

    var body: some View {
        Section {
            let noun = AccountsLogic.plural(count, "transfer")
            Text("Found \(noun) to this account in your other accounts. Fill \(count == 1 ? "it" : "them") in?")
            Button {
                Task { await fill() }
            } label: {
                Label("Fill them in", systemImage: "arrow.left.arrow.right")
            }
            .disabled(store.busy)
        } header: {
            Text("Fill from transfers")
        }
    }

    private func fill() async {
        let result = await store.submit("enableFillFromTransfers", showRefusal: true)
        guard let result else { return }
        var summary = "Nothing to fill in."
        if let decoded = try? result.decode(AccountFillResult.self) {
            let text = AccountsLogic.transferSummary(linked: decoded.paired, mirrored: decoded.mirrored, needsAmount: decoded.needsAmount)
            if let text { summary = text }
        }
        store.message = "Filled from transfers: " + summary
    }
}

/// Transfers in another currency that wait for the amount this account booked.
struct AccountNeedsAmountSection: View {
    let store: PageStore<AccountPage>
    let items: [AccountPage.NeedsAmount]

    var body: some View {
        Section {
            ForEach(items) { item in
                AccountNeedsAmountRow(store: store, item: item)
            }
        } header: {
            Text("Needs amount")
        } footer: {
            Text("\(AccountsLogic.plural(items.count, "transfer")) in another currency. Enter the amount this account booked and Kept creates the transaction.")
        }
    }
}

struct AccountNeedsAmountRow: View {
    let store: PageStore<AccountPage>
    let item: AccountPage.NeedsAmount

    @Environment(\.formats) private var formats
    @State private var amount = ""

    private var incoming: Bool { item.direction == "in" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(incoming ? "From" : "To") \(item.sourceAccountName) on \(formats.date(item.bookingDate))")
            if let description = item.description, !description.isEmpty {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Text(incoming ? "Paid" : "Received")
                AmountText(Int64(item.amount.magnitude), item.currency)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            candidate
            entry
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var candidate: some View {
        if let candidate = item.linkCandidate {
            VStack(alignment: .leading, spacing: 4) {
                Text("This account has a transaction on \(formats.date(candidate.bookingDate)) that may be the other side:")
                    .font(.caption)
                AmountText(candidate.amount, candidate.currency, tone: .signed, showPlus: true)
                    .font(.caption)
                Button("Link instead") {
                    Task { await linkInstead(candidate.id) }
                }
                .buttonStyle(.borderless)
                .disabled(store.busy)
            }
        }
    }

    private var entry: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                AmountField(incoming ? "Amount received" : "Amount paid", text: $amount, currency: item.targetCurrency)
                Button("Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderless)
                .disabled(store.busy || amount.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            FieldError(store.formErrors["amount"])
        }
    }

    private func save() async {
        var form = FormFields()
        form.set("transferId", item.transferId)
        form.set("amount", amount)
        await store.submit("resolveNeedsAmount", form: form)
    }

    private func linkInstead(_ peerId: String) async {
        var form = FormFields()
        form.set("transferId", item.transferId)
        form.set("peerId", peerId)
        await store.submit("linkNeedsAmount", form: form, showRefusal: true)
    }
}
