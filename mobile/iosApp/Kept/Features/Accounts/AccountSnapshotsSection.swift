import SwiftUI

/// Balance snapshots: the balance recorded on a given day, for accounts that are not imported.
struct AccountSnapshotsSection: View {
    let page: AccountPage
    @Binding var sheet: AccountDetailSheet?
    @Binding var confirm: AccountDetailConfirm?

    @Environment(\.formats) private var formats

    var body: some View {
        Section {
            if page.snapshots.isEmpty {
                Text("No balance snapshots. Record the balance on a given day to track this account over time.")
                    .foregroundStyle(.secondary)
            }
            ForEach(page.snapshots) { snapshot in
                row(snapshot)
            }
            Button {
                sheet = .addSnapshot
            } label: {
                Label("Add snapshot", systemImage: "plus")
            }
        } header: {
            Text("Balance snapshots")
        } footer: {
            Text(footer)
        }
    }

    private var footer: String {
        if page.showPortfolios {
            return "Once portfolio values exist, this account is worth its portfolios alone, so balance snapshots do not affect its value. Snapshots still shape the history before the first portfolio value."
        }
        if page.hasHoldings {
            return "Snapshots record the cash balance of this account. The value of your holdings is added on top, so leave it out."
        }
        return "Use balance snapshots for accounts you don't import, e.g. pension accounts."
    }

    @ViewBuilder
    private func row(_ snapshot: AccountPage.Snapshot) -> some View {
        let manual = snapshot.source == "manual"
        ValueRow(
            formats.date(snapshot.date),
            subtitle: snapshot.note
        ) {
            AmountText(snapshot.amount, page.account.currency)
            Pill(manual ? "manual" : "imported")
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if manual {
                Button(role: .destructive) {
                    confirm = AccountDetailConfirm(
                        action: "deleteSnapshot",
                        field: "snapshotId",
                        targetId: snapshot.id,
                        title: "Delete this snapshot?",
                        message: "The balance recorded on \(formats.date(snapshot.date)) will be removed. Your transactions are not affected.",
                        button: "Delete"
                    )
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }
}

/// Record the balance of the account on a day ("addSnapshot").
struct AccountSnapshotSheet: View {
    let store: PageStore<AccountPage>
    let account: AccountPage.Account

    @State private var date = Formats.isoDate(Date())
    @State private var amount = ""
    @State private var note = ""

    var body: some View {
        FormSheet("Add balance snapshot", busy: store.busy, error: store.formErrors["form"], submitLabel: "Add") {
            await save()
        } content: {
            Section {
                DateField("Date", value: $date)
                FieldError(store.formErrors["date"])
                AmountField("Balance", text: $amount, currency: account.currency)
                FieldError(store.formErrors["amount"])
                TextField("Note (optional)", text: $note)
                FieldError(store.formErrors["note"])
            } footer: {
                Text("The balance at the end of the chosen day. Use a minus sign for a negative balance.")
            }
        }
    }

    private func save() async -> Bool {
        var form = FormFields()
        form.set("date", date)
        form.set("amount", amount)
        form.set("note", note)
        let result = await store.submit("addSnapshot", form: form)
        return result != nil
    }
}

/// Delete the account after typing its name ("deleteAccount").
struct AccountDeleteSheet: View {
    let store: PageStore<AccountPage>
    let account: AccountPage.Account

    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""

    private var matches: Bool {
        return typed.trimmingCharacters(in: .whitespaces) == account.name
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("All transactions, balance snapshots and portfolios of this account are deleted permanently, including imported ones. This cannot be undone. Archive the account instead to hide it and keep its history.")
                } footer: {
                    Text("Type the account name to confirm: \(account.name)")
                }
                Section {
                    TextField("Account name", text: $typed)
                        .autocorrectionDisabled()
                    FieldError(store.formErrors["form"])
                }
                Section {
                    Button("Delete account", role: .destructive) {
                        Task { await delete() }
                    }
                    .disabled(!matches || store.busy)
                }
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func delete() async {
        let result = await store.submit("deleteAccount", showRefusal: true, reload: false)
        if result != nil { dismiss() }
    }
}
