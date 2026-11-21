import SwiftUI

/// The reconciliation tab: balance, the paired lines, statement lines to add, and the year's details.
struct TaxReconciliationSections: View {
    let store: PageStore<TaxYearPage>
    let page: TaxYearPage
    let onAddCredit: () -> Void
    let onEditDetails: () -> Void
    let onDeleteCredit: (TaxYearPage.Credit) -> Void
    let onDeleteYear: () -> Void

    @Environment(\.formats) private var formats

    private var reconciliation: TaxYearPage.Reconciliation { page.reconciliation }
    private var currency: String { reconciliation.year.currency }

    var body: some View {
        Group {
            balanceSection
            noticeSection
            rowsSection
            addSection
            detailsSection
        }
    }

    // MARK: Balance

    @ViewBuilder
    private var balanceSection: some View {
        let balance = reconciliation.balance
        Section {
            LabeledContent("Paid by you") { AmountText(balance.paidByMe, currency) }
            LabeledContent("Counted by the tax office") { AmountText(balance.creditedByOffice, currency) }
            LabeledContent("Assessed total") {
                if let assessed = balance.assessedTotal {
                    AmountText(assessed, currency)
                } else {
                    Text("Not entered").foregroundStyle(.secondary)
                }
            }
            LabeledContent(openTitle(balance)) {
                outcomeValue(balance)
            }
            if let byMe = balance.remainingByMe, byMe != balance.remaining {
                LabeledContent("By your payments") { AmountText(byMe, currency) }
                    .font(.footnote)
            }
        }
    }

    private func openTitle(_ balance: TaxBalance) -> String {
        balance.outcome == "refund" ? "Refund to expect" : "Still open"
    }

    @ViewBuilder
    private func outcomeValue(_ balance: TaxBalance) -> some View {
        if let amount = TaxText.outcomeAmount(balance) {
            HStack(spacing: 6) {
                Text(TaxText.outcomeLabel(balance)).foregroundStyle(.secondary)
                AmountText(amount, currency, tone: balance.outcome == "refund" ? .signed : .plain)
            }
        } else {
            Text(TaxText.outcomeLabel(balance)).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var noticeSection: some View {
        if reconciliation.otherCurrencyLines > 0 {
            Section {
                Label(otherCurrencyText, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(KeptColor.warning)
            }
        }
    }

    private var otherCurrencyText: String {
        let count = reconciliation.otherCurrencyLines
        let noun = count == 1 ? "tagged payment is" : "tagged payments are"
        return "\(count) \(noun) in another currency than \(currency) and not counted here."
    }

    // MARK: Rows

    @ViewBuilder
    private var rowsSection: some View {
        Section {
            if reconciliation.rows.isEmpty {
                Text("Nothing to compare yet. Add the lines from the tax office's statement below, and mark your payments with this tax year in the transaction details.")
                    .foregroundStyle(.secondary)
            }
            ForEach(reconciliation.rows) { row in
                rowView(row)
            }
        } header: {
            HStack {
                Text("Reconciliation")
                if reconciliation.reconciled {
                    Pill("All lines match", color: KeptColor.positive)
                } else if reconciliation.differences > 0 {
                    Pill(TaxText.differencesText(reconciliation.differences), color: KeptColor.negative)
                }
            }
        } footer: {
            Text("Your payments are paired with the tax office's statement lines by reference, amount and date (within a week). Swipe a line to delete a statement line or to remove the tax year from a payment.")
        }
    }

    private func rowView(_ row: TaxYearPage.Row) -> some View {
        TaxReconciliationRow(
            row: row,
            currency: currency,
            suggestions: suggestions(for: row),
            onTag: { suggestion in
                Task { await tag(suggestion) }
            }
        )
        .swipeActions {
            if let office = row.office {
                Button(role: .destructive) {
                    onDeleteCredit(office)
                } label: {
                    Label("Delete line", systemImage: "trash")
                }
            }
            if let mine = row.mine, mine.via == "tagged" {
                Button {
                    Task { await untag(mine) }
                } label: {
                    Label("Untag", systemImage: "xmark")
                }
                .tint(.orange)
            }
        }
    }

    private func suggestions(for row: TaxYearPage.Row) -> [TaxYearPage.Suggestion] {
        guard row.kind == "missing_mine", let office = row.office else { return [] }
        return reconciliation.suggestions.filter { $0.creditId == office.id }
    }

    private func tag(_ suggestion: TaxYearPage.Suggestion) async {
        await store.submit("tag", form: TaxText.transactionForm(suggestion.transactionId), showRefusal: true)
    }

    private func untag(_ payment: TaxYearPage.Payment) async {
        await store.submit("untag", form: TaxText.transactionForm(payment.transactionId), showRefusal: true)
    }

    // MARK: Add and details

    @ViewBuilder
    private var addSection: some View {
        Section {
            Button {
                onAddCredit()
            } label: {
                Label("Add a statement line", systemImage: "plus")
            }
        } footer: {
            Text("From the tax office's account statement. Use a minus sign for money they paid back to you.")
        }
    }

    @ViewBuilder
    private var detailsSection: some View {
        let details = reconciliation.year
        Section {
            LabeledContent("Authority") {
                Text(details.authority ?? "Not entered").foregroundStyle(.secondary)
            }
            if let notes = details.notes, !notes.isEmpty {
                Text(notes).font(.footnote).foregroundStyle(.secondary)
            }
            Button("Edit details") { onEditDetails() }
            if details.id != nil {
                Button("Delete this tax year's details", role: .destructive) { onDeleteYear() }
            }
        } header: {
            Text("Details")
        } footer: {
            Text("The tax authority and the assessed total of the final assessment.")
        }
    }
}

/// One line of the reconciliation: your payment, the tax office's line, and what differs.
private struct TaxReconciliationRow: View {
    let row: TaxYearPage.Row
    let currency: String
    let suggestions: [TaxYearPage.Suggestion]
    let onTag: (TaxYearPage.Suggestion) -> Void

    @Environment(\.formats) private var formats

    private var matched: Bool { row.kind == "matched" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Pill(TaxText.rowLabel(row.kind), color: matched ? KeptColor.positive : KeptColor.negative)
                Spacer()
                if !matched {
                    AmountText(row.difference, currency, showPlus: true).font(.caption)
                }
            }
            paymentBlock
            creditBlock
            ForEach(suggestions) { suggestion in
                suggestionView(suggestion)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var paymentBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Your payment").font(.caption).foregroundStyle(.secondary)
            if let mine = row.mine {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(formats.date(mine.date)).font(.subheadline)
                        if let label = mine.label, !label.isEmpty {
                            Text(label).font(.subheadline).lineLimit(2)
                        }
                        referenceText(mine.reference)
                        Text(mine.via == "bill" ? "Via a tagged bill" : "Tagged transaction")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    AmountText(mine.amount, currency).fontWeight(.medium)
                }
            } else {
                missingText
            }
        }
    }

    @ViewBuilder
    private var creditBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Tax office").font(.caption).foregroundStyle(.secondary)
            if let office = row.office {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(formats.date(office.date)).font(.subheadline)
                        if let description = office.description, !description.isEmpty {
                            Text(description).font(.subheadline).lineLimit(2)
                        }
                        referenceText(office.reference)
                    }
                    Spacer(minLength: 8)
                    AmountText(office.amount, currency).fontWeight(.medium)
                }
            } else {
                missingText
            }
        }
    }

    private var missingText: some View {
        Text("Missing").font(.subheadline.weight(.medium)).foregroundStyle(KeptColor.negative)
    }

    @ViewBuilder
    private func referenceText(_ reference: String?) -> some View {
        if let reference, !reference.isEmpty {
            Text(reference).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private func suggestionText(_ suggestion: TaxYearPage.Suggestion) -> String {
        var text = "Possible payment: " + formats.date(suggestion.bookingDate)
        if let label = suggestion.label, !label.isEmpty { text += " · " + label }
        return text
    }

    private func suggestionView(_ suggestion: TaxYearPage.Suggestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(suggestionText(suggestion)).font(.footnote)
                Spacer(minLength: 8)
                AmountText(suggestion.amount, currency).font(.footnote)
            }
            Button("Count as tax payment") { onTag(suggestion) }
                .buttonStyle(.borderless)
                .font(.footnote.weight(.semibold))
        }
        .padding(8)
        .background(KeptColor.muted, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// The deductions tab: the pillar 3a figures, what counts per type, what is excluded, and the category mapping.
struct TaxDeductionsSections: View {
    let store: PageStore<TaxYearPage>
    let page: TaxYearPage

    @Environment(\.formats) private var formats

    var body: some View {
        Group {
            pillarSection
            totalsSections
            excludedSection
            mappingSection
        }
    }

    // MARK: Pillar 3a

    @ViewBuilder
    private var pillarSection: some View {
        if let pillar = page.pillar3a {
            Section {
                LabeledContent(limitTitle(pillar)) {
                    if let limit = pillar.limit {
                        AmountText(limit, "CHF")
                    } else {
                        Text("n/a").foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Ordinary") { AmountText(pillar.ordinary, "CHF") }
                LabeledContent("Buy-in") { AmountText(pillar.buyIn, "CHF") }
                LabeledContent("Deductible") {
                    AmountText(pillar.deductible, "CHF").fontWeight(.semibold)
                }
                if pillar.excluded != 0 {
                    LabeledContent("Excluded") { AmountText(pillar.excluded, "CHF") }
                        .font(.footnote)
                }
                NavigationLink("Open Pillar 3a", value: Route.pillar3a)
            } header: {
                Text("Pillar 3a \(page.deductions.year)")
            } footer: {
                Text("Contributions credited in \(page.deductions.year). Included in the deductions below.")
            }
        }
    }

    private func limitTitle(_ pillar: TaxYearPage.Pillar3a) -> String {
        pillar.limitUnconfirmed ? "Limit (estimate)" : "Limit"
    }

    // MARK: Totals

    @ViewBuilder
    private var totalsSections: some View {
        if page.deductions.totals.isEmpty {
            Section {
                Text("No deductions for \(page.deductions.year). Map your categories to deduction types below.")
                    .foregroundStyle(.secondary)
            } header: {
                Text("Deductions \(page.deductions.year)")
            }
        } else {
            ForEach(page.deductions.totals) { group in
                Section {
                    ForEach(group.lines) { line in
                        lineRow(line)
                    }
                } header: {
                    HStack {
                        Text(TaxText.deductionLabel(group.type) + " (" + group.currency + ")")
                        Spacer()
                        AmountText(group.total, group.currency).fontWeight(.semibold)
                    }
                    .textCase(nil)
                }
            }
        }
    }

    private func lineTitle(_ line: TaxYearPage.Line) -> String {
        var text = formats.date(line.date)
        if let label = line.label, !label.isEmpty { text += " · " + label }
        return text
    }

    private func lineRow(_ line: TaxYearPage.Line) -> some View {
        let subtitle: String? = line.explicitYear ? "Deduction year set" : nil
        return ValueRow(lineTitle(line), subtitle: subtitle) {
            AmountText(line.amount, line.currency)
        }
        .swipeActions {
            if let transactionId = line.transactionId {
                Button {
                    Task { await exclude(transactionId) }
                } label: {
                    Label("Exclude", systemImage: "xmark.circle")
                }
                .tint(.orange)
            }
        }
    }

    private func exclude(_ transactionId: String) async {
        await store.submit("excludeDeduction", form: TaxText.transactionForm(transactionId), showRefusal: true)
    }

    private func include(_ transactionId: String) async {
        await store.submit("includeDeduction", form: TaxText.transactionForm(transactionId), showRefusal: true)
    }

    // MARK: Excluded

    @ViewBuilder
    private var excludedSection: some View {
        if !page.deductions.excluded.isEmpty {
            Section {
                ForEach(page.deductions.excluded) { line in
                    excludedRow(line)
                }
            } header: {
                Text("Excluded")
            } footer: {
                Text("Swipe a line to count it again.")
            }
        }
    }

    private func excludedRow(_ line: TaxYearPage.Line) -> some View {
        let kind: String = line.type.map { TaxText.deductionLabel($0) } ?? ""
        return ValueRow(lineTitle(line), subtitle: kind) {
            AmountText(line.amount, line.currency)
        }
        .foregroundStyle(.secondary)
        .swipeActions {
            if let transactionId = line.transactionId {
                Button {
                    Task { await include(transactionId) }
                } label: {
                    Label("Include", systemImage: "arrow.clockwise")
                }
                .tint(.accentColor)
            }
        }
    }

    // MARK: Mapping

    @ViewBuilder
    private var mappingSection: some View {
        Section {
            if page.deductionMappings.isEmpty {
                Text("No categories yet. Create categories in Settings to map them to deduction types.")
                    .foregroundStyle(.secondary)
            }
            ForEach(page.deductionMappings) { mapping in
                TaxMappingRow(store: store, mapping: mapping)
            }
        } header: {
            Text("Category mapping")
        } footer: {
            Text("Choose which deduction type each of your categories belongs to. Subcategories use their parent's type unless you set their own.")
        }
    }
}

private struct TaxMappingRow: View {
    let store: PageStore<TaxYearPage>
    let mapping: TaxYearPage.Mapping

    private var selection: Binding<String> {
        Binding(
            get: { mapping.own ?? "" },
            set: { value in
                if value == (mapping.own ?? "") { return }
                Task {
                    let form = TaxText.setDeductionForm(categoryId: mapping.categoryId, type: value)
                    await store.submit("setDeduction", form: form, showRefusal: true)
                }
            }
        )
    }

    var body: some View {
        Picker(mapping.name, selection: selection) {
            Text(TaxText.mappingNoneLabel(inherited: mapping.inherited, effective: mapping.effective)).tag("")
            ForEach(TaxText.deductionTypes, id: \.self) { type in
                Text(TaxText.deductionLabel(type)).tag(type)
            }
        }
        .padding(.leading, mapping.parentId == nil ? 0 : 16)
        .disabled(store.busy)
    }
}
