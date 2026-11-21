import SwiftUI

/// The import history of an account, with undo.
struct AccountImportsView: View {
    let id: String
    @State private var store: PageStore<AccountImportsPage>
    @Environment(Router.self) private var router
    @State private var target: AccountImportsPage.Entry?
    @State private var confirmUndo = false

    init(id: String) {
        self.id = id
        _store = State(initialValue: PageStore<AccountImportsPage>(path: "accounts/\(id)/imports"))
    }

    var body: some View {
        PageView("Import history", store: store) { page in
            content(page)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    router.push(.importFiles)
                } label: {
                    Label("Import", systemImage: "square.and.arrow.down")
                }
            }
        }
        .confirmationDialog("Undo this import?", isPresented: $confirmUndo, titleVisibility: .visible) {
            Button("Undo import", role: .destructive) {
                if let target {
                    Task { await undo(target) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(undoMessage())
        }
    }

    private func undoMessage() -> String {
        guard let target, let page = store.state.value else { return "" }
        var text = "Removes the \(AccountsLogic.plural(target.newCount, "transaction")) this import added. "
        text += "Transactions also contained in later imports are removed too because they were first added by this import."
        if let impact = page.impacts[target.id] {
            let lost = AccountsLogic.describeImpact(impact)
            if !lost.isEmpty {
                text += "\n\nYour edits on these transactions are lost too: " + lost.joined(separator: ", ") + "."
            }
        }
        return text
    }

    @ViewBuilder
    private func content(_ page: AccountImportsPage) -> some View {
        if page.imports.isEmpty {
            ContentUnavailableView {
                Label("No imports yet", systemImage: "clock")
            } description: {
                Text("Statements you import into \(page.account.name) are listed here, and you can undo them.")
            } actions: {
                Button("Import a statement") { router.push(.importFiles) }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            List {
                Section {
                    ForEach(page.imports) { entry in
                        AccountImportRow(entry: entry) {
                            target = entry
                            confirmUndo = true
                        }
                    }
                } header: {
                    Text(page.account.name)
                }
            }
        }
    }

    private func undo(_ entry: AccountImportsPage.Entry) async {
        var form = FormFields()
        form.set("importId", entry.id)
        let result = await store.submit("undo", form: form, showRefusal: true)
        guard let result else { return }
        var removed = 0
        if let decoded = try? result.decode(AccountUndoResult.self) { removed = decoded.removedTransactions }
        store.message = "Import undone. \(AccountsLogic.plural(removed, "transaction")) removed."
    }
}

private struct AccountImportRow: View {
    let entry: AccountImportsPage.Entry
    let onUndo: () -> Void

    @Environment(\.formats) private var formats

    private var importedAt: Date {
        return Date(timeIntervalSince1970: Double(entry.createdAt) / 1000)
    }

    private var period: String {
        if let from = entry.statementFrom, let to = entry.statementTo {
            if from == to { return formats.date(from) }
            return "\(formats.date(from)) \u{2013} \(formats.date(to))"
        }
        if let single = entry.statementFrom ?? entry.statementTo { return formats.date(single) }
        return "No period"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.fileName).lineLimit(2)
                    Text(importedAt, format: .dateTime.day().month().year().hour().minute())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Pill(AccountsLogic.formatLabel(entry.format))
            }
            Text(period).font(.footnote).foregroundStyle(.secondary)
            balances
            HStack {
                Text("\(entry.newCount) new \u{00B7} \(entry.duplicateCount) duplicate")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Undo", role: .destructive, action: onUndo)
                    .buttonStyle(.borderless)
            }
            warnings
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var balances: some View {
        if entry.openingBalance != nil || entry.closingBalance != nil {
            HStack(spacing: 6) {
                balance(entry.openingBalance)
                Text("\u{2192}").foregroundStyle(.secondary)
                balance(entry.closingBalance)
            }
            .font(.footnote)
        }
    }

    @ViewBuilder
    private func balance(_ value: Int64?) -> some View {
        if let value {
            AmountText(value, entry.currency)
        } else {
            Text("\u{2014}").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var warnings: some View {
        if !entry.warnings.isEmpty {
            DisclosureGroup {
                ForEach(Array(entry.warnings.enumerated()), id: \.offset) { _, warning in
                    Text(warning).font(.caption).foregroundStyle(.secondary)
                }
            } label: {
                Label(AccountsLogic.plural(entry.warnings.count, "warning"), systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(KeptColor.warning)
            }
        }
    }
}
