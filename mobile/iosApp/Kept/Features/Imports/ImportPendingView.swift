import SwiftUI

/// The preview of an uploaded statement: what would be imported, then confirm or cancel.
struct ImportPendingView: View {
    let pendingId: String

    @State private var store: PageStore<ImportPendingPage>
    @State private var confirmCancel = false

    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats
    @Environment(\.session) private var session

    init(pendingId: String) {
        self.pendingId = pendingId
        _store = State(initialValue: PageStore<ImportPendingPage>(path: "import/\(pendingId)"))
    }

    var body: some View {
        PageView("Review import", store: store) { page in
            List {
                summarySection(page)
                alerts(page)
                mappingSection(page)
                rowsSection(page)
            }
            .safeAreaInset(edge: .bottom) {
                actionBar(page)
            }
        }
        .confirmationDialog("Cancel this import?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Discard the file", role: .destructive) {
                Task { await store.submit("cancel", reload: false) }
            }
            Button("Keep reviewing", role: .cancel) {}
        } message: {
            Text("The uploaded file is deleted. Nothing is imported.")
        }
    }

    private var isTabular: Bool {
        guard let page = store.state.value else { return false }
        return page.format == "csv" || page.format == "xlsx"
    }

    // MARK: Summary

    @ViewBuilder
    private func summarySection(_ page: ImportPendingPage) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(page.fileName).font(.headline).lineLimit(2)
                    Pill(ImportText.formatLabel(page.format))
                }
                Text(accountLine(page)).font(.caption).foregroundStyle(.secondary)
            }
            LabeledContent("Statement period") {
                Text(periodText(page))
            }
            balanceRow("Opening balance", page.statement?.openingBalance)
            balanceRow("Closing balance", page.statement?.closingBalance)
            countsRow(page)
        }
    }

    private func accountLine(_ page: ImportPendingPage) -> String {
        var line = "Into \(page.account.name)"
        if let iban = page.account.iban, let shown = ImportText.iban(iban, display: session?.preferences.ibanDisplay ?? "full") {
            line += " · " + shown
        }
        return line
    }

    private func periodText(_ page: ImportPendingPage) -> String {
        guard let statement = page.statement else { return "Unknown" }
        return ImportText.period(statement.fromDate, statement.toDate, formats: formats)
    }

    @ViewBuilder
    private func balanceRow(_ title: String, _ balance: ImportPendingPage.Balance?) -> some View {
        LabeledContent(title) {
            if let balance {
                VStack(alignment: .trailing, spacing: 2) {
                    AmountText(balance.amount, balance.currency)
                    if let date = balance.date {
                        Text(formats.date(date)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("Not in file").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func countsRow(_ page: ImportPendingPage) -> some View {
        let brandNew = page.counts.new - page.counts.replacesMirror
        HStack {
            countCell("New", brandNew)
            if page.counts.replacesMirror > 0 {
                countCell("Replaces mirror", page.counts.replacesMirror)
            }
            countCell("Duplicates", page.counts.duplicate)
            countCell("Total", page.counts.total)
        }
    }

    private func countCell(_ title: String, _ value: Int) -> some View {
        VStack(spacing: 2) {
            Text("\(value)").font(.title3.weight(.semibold)).monospacedDigit()
            Text(title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Alerts

    @ViewBuilder
    private func alerts(_ page: ImportPendingPage) -> some View {
        if let at = page.alreadyImportedAt {
            Section {
                Label {
                    Text("An identical file was imported on \(ImportText.dateTime(at, locale: formats.locale)). Importing it again adds only transactions that are not in the account yet.")
                } icon: {
                    Image(systemName: "checkmark.circle")
                }
            } header: {
                Text("This file was imported before")
            }
        }
        let warningCount = page.warnings.count + page.balanceWarnings.count
        if warningCount > 0 {
            Section {
                ForEach(Array(page.warnings.enumerated()), id: \.offset) { _, warning in
                    Text(warning).font(.footnote)
                }
                ForEach(Array(page.balanceWarnings.enumerated()), id: \.offset) { _, warning in
                    Text(balanceWarningText(warning)).font(.footnote)
                }
            } header: {
                Text(ImportText.plural(warningCount, "warning"))
                    .foregroundStyle(KeptColor.warning)
            }
        }
        if !page.errors.isEmpty {
            let otherErrors = page.errors.filter { $0 != "mapping_required" }
            Section {
                if page.needsMapping {
                    Text("This file needs a column mapping before it can be imported.")
                }
                ForEach(Array(otherErrors.enumerated()), id: \.offset) { _, error in
                    Text(error)
                }
            } header: {
                Text("This file cannot be imported yet").foregroundStyle(KeptColor.negative)
            }
        }
    }

    private func balanceWarningText(_ warning: ImportPendingPage.BalanceWarning) -> String {
        let file = formats.money(warning.fileAmount, warning.currency)
        let ledger = formats.money(warning.ledgerAmount, warning.currency)
        let date = formats.date(warning.date)
        let tail = " This usually means a gap between imports or missing transactions."
        if formats.hideAmounts {
            return "The balances in this file do not match the ledger around \(date)." + tail
        }
        if warning.code == "opening_mismatch" {
            return "The file's opening balance (\(file) on \(date)) does not match the ledger balance at the end of the previous day (\(ledger))." + tail
        }
        return "After this import the ledger balance on \(date) would be \(ledger), but the file's closing balance is \(file)." + tail
    }

    @ViewBuilder
    private func mappingSection(_ page: ImportPendingPage) -> some View {
        if page.needsMapping {
            Section {
                NavigationLink(value: Route.importMapping(page.pendingId)) {
                    Label("Map columns", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
        } else if isTabular {
            Section {
                NavigationLink(value: Route.importMapping(page.pendingId)) {
                    Label("Edit column mapping", systemImage: "pencil")
                }
            }
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func rowsSection(_ page: ImportPendingPage) -> some View {
        Section {
            filterPicker(page)
            if page.rows.isEmpty {
                Text(emptyText(page)).foregroundStyle(.secondary)
            }
            ForEach(page.rows) { row in
                ImportPendingRow(row: row)
            }
            if page.pageCount > 1 {
                pager(page)
            }
        } header: {
            Text("Transactions")
        }
    }

    private func emptyText(_ page: ImportPendingPage) -> String {
        if page.counts.total == 0 { return "No transactions could be read from this file." }
        switch page.filter {
        case "new": return "No new transactions in this file."
        case "replaces_mirror": return "No transactions that replace a mirror in this file."
        default: return "No duplicates in this file."
        }
    }

    @ViewBuilder
    private func filterPicker(_ page: ImportPendingPage) -> some View {
        let brandNew = page.counts.new - page.counts.replacesMirror
        Picker("Show", selection: filterBinding(page.filter)) {
            Text("All (\(page.counts.total))").tag("all")
            Text("New (\(brandNew))").tag("new")
            if page.counts.replacesMirror > 0 {
                Text("Replaces mirror (\(page.counts.replacesMirror))").tag("replaces_mirror")
            }
            Text("Duplicates (\(page.counts.duplicate))").tag("duplicate")
        }
        .pickerStyle(.menu)
    }

    private func filterBinding(_ current: String) -> Binding<String> {
        Binding(
            get: { current },
            set: { value in
                store.query["filter"] = value
                store.query["page"] = nil
                Task { await store.load() }
            }
        )
    }

    @ViewBuilder
    private func pager(_ page: ImportPendingPage) -> some View {
        let first = (page.page - 1) * page.pageSize + 1
        let last = min(page.page * page.pageSize, page.filteredTotal)
        HStack {
            Button("Previous") { go(page.page - 1) }
                .disabled(page.page <= 1)
            Spacer()
            Text("\(first)–\(last) of \(page.filteredTotal)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Next") { go(page.page + 1) }
                .disabled(page.page >= page.pageCount)
        }
        .buttonStyle(.borderless)
    }

    private func go(_ target: Int) {
        store.query["page"] = String(target)
        Task { await store.load() }
    }

    // MARK: Actions

    private func confirmLabel(_ page: ImportPendingPage) -> String {
        if page.canConfirm, page.counts.new == 0 { return "Nothing new to import" }
        return "Import " + ImportText.plural(page.counts.new, "transaction")
    }

    @ViewBuilder
    private func actionBar(_ page: ImportPendingPage) -> some View {
        VStack(spacing: 8) {
            FieldError(store.formErrors["form"])
            HStack {
                Button("Cancel") { confirmCancel = true }
                    .buttonStyle(.bordered)
                    .disabled(store.busy)
                Spacer()
                if store.busy {
                    ProgressView()
                } else {
                    Button(confirmLabel(page)) {
                        Task { await store.submit("confirm", reload: false) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!page.canConfirm || page.counts.new == 0)
                }
            }
        }
        .padding()
        .background(.bar)
    }
}

/// One row of the preview: who, how much, and what the import would do with it.
struct ImportPendingRow: View {
    let row: ImportPendingPage.Row

    @Environment(\.formats) private var formats

    private var title: String {
        if let name = row.tx.counterpartyName, !name.isEmpty { return name }
        if let description = row.tx.description, !description.isEmpty { return description }
        return "—"
    }

    private var detail: String {
        var parts: [String] = []
        if row.tx.counterpartyName != nil, let description = row.tx.description, !description.isEmpty {
            parts.append(description)
        }
        if let reference = row.tx.reference, !reference.isEmpty { parts.append(reference) }
        return parts.joined(separator: "\n")
    }

    private var statusLabel: String {
        switch row.status {
        case "new": return "New"
        case "replaces_mirror": return "Replaces mirror"
        case "duplicate_in_file": return "Duplicate in file"
        default: return "Duplicate"
        }
    }

    private var statusColor: Color {
        switch row.status {
        case "new": return KeptColor.positive
        case "replaces_mirror": return KeptColor.charts[1]
        default: return .secondary
        }
    }

    private var note: String? {
        if row.status == "replaces_mirror" {
            return "Takes over a transaction Kept created from a transfer."
        }
        if row.status == "duplicate", row.matchedBy == "legacy_id" {
            return "Matched an earlier import by its old id."
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).lineLimit(2)
                Spacer(minLength: 8)
                AmountText(row.tx.amount, row.tx.currency, tone: .signed)
            }
            if !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack {
                Text(formats.date(row.tx.bookingDate)).font(.caption).foregroundStyle(.secondary)
                Pill(statusLabel, color: statusColor)
            }
            if let note {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}
