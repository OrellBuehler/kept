import SwiftUI

/// Which contribution the form edits (nil: a new manual one), optionally with the type preset.
struct Pillar3aContributionTarget: Identifiable {
    let id: String
    let contribution: Pillar3aPage.Contribution?
    let presetKind: String?
}

/// Pillar 3a: yearly limits and gaps, portfolios, and the contributions that count towards them.
struct Pillar3aView: View {
    @State private var store = PageStore<Pillar3aPage>(path: "pillar-3a")
    @State private var yearTarget: Pillar3aPage.Year?
    @State private var contributionTarget: Pillar3aContributionTarget?
    @State private var deleting: Pillar3aPage.Contribution?
    @State private var deletingOrphan: Pillar3aPage.Orphan?
    @State private var yearFilter = "all"
    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats

    private let currency = "CHF"

    var body: some View {
        PageView("Pillar 3a", store: store) { page in
            content(page)
        }
        .sheet(item: $yearTarget) { year in
            Pillar3aYearSheet(store: store, year: year)
        }
        .sheet(item: $contributionTarget) { target in
            Pillar3aContributionSheet(
                store: store,
                contribution: target.contribution,
                presetKind: target.presetKind,
                portfolios: store.state.value?.overview.portfolios ?? [],
                gaps: store.state.value?.overview.gaps ?? []
            )
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: deleteBinding,
            titleVisibility: .visible
        ) {
            Button(deleteButton, role: .destructive) {
                if let target = deleting {
                    Task { await deleteContribution(target) }
                }
            }
        } message: {
            Text(deleteMessage)
        }
        .confirmationDialog(
            "Delete this annotation?",
            isPresented: orphanBinding,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let target = deletingOrphan {
                    Task { await deleteOrphan(target) }
                }
            }
        } message: {
            Text("The annotation is removed and any gap years it holds are released.")
        }
    }

    // MARK: Delete dialogs

    private var isReset: Bool { deleting?.source == "detected" }

    private var deleteTitle: String {
        isReset ? "Reset this contribution?" : "Delete this contribution?"
    }

    private var deleteButton: String {
        isReset ? "Reset" : "Delete"
    }

    private var deleteMessage: String {
        if isReset {
            return "The payment stays, but its type, credit date, gap years and note are reset to an ordinary contribution on the booking date."
        }
        return "This contribution is removed and any gap years it closed are released."
    }

    private var deleteBinding: Binding<Bool> {
        Binding(
            get: { deleting != nil },
            set: { value in
                if !value { deleting = nil }
            }
        )
    }

    private var orphanBinding: Binding<Bool> {
        Binding(
            get: { deletingOrphan != nil },
            set: { value in
                if !value { deletingOrphan = nil }
            }
        )
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ page: Pillar3aPage) -> some View {
        if page.accounts.isEmpty {
            ContentUnavailableView {
                Label("No Pillar 3a account yet", systemImage: "banknote")
            } description: {
                Text("Create an account of type Pillar 3a, with your contract number and the IBAN you pay into, then add its portfolios.")
            } actions: {
                Button("Go to accounts") { router.tab = .accounts }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            List {
                totalsSection(page.overview.totals)
                yearsSection(page)
                portfoliosSection(page.overview.portfolios)
                contributionsSection(page)
                orphansSection(page.overview.orphanAnnotations)
            }
        }
    }

    @ViewBuilder
    private func totalsSection(_ totals: Pillar3aPage.Totals) -> some View {
        Section {
            LabeledContent("Value") {
                AmountText(totals.value, currency).font(.title3.weight(.semibold))
            }
            LabeledContent("Contributed") { AmountText(totals.contributed, currency) }
            LabeledContent("Gain") {
                AmountText(totals.gain, currency, tone: .signed, showPlus: true)
            }
        } footer: {
            Text("Locked until withdrawal, and not subject to wealth tax. Open portfolios only.")
        }
    }

    // MARK: Years

    @ViewBuilder
    private func yearsSection(_ page: Pillar3aPage) -> some View {
        Section {
            if page.overview.years.isEmpty {
                Text("Years appear here once there are contributions to track.")
                    .foregroundStyle(.secondary)
            }
            ForEach(page.overview.years) { year in
                Button {
                    yearTarget = year
                } label: {
                    Pillar3aYearRow(year: year, thisYear: page.thisYear)
                }
                .tint(.primary)
            }
        } header: {
            Text("Years")
        } footer: {
            Text("Limits are per person, across all your 3a accounts. A payment counts for the year it is credited. Missed years from 2025 on can be bought in later. Tap a year to set its deduction.")
        }
    }

    // MARK: Portfolios

    @ViewBuilder
    private func portfoliosSection(_ portfolios: [Pillar3aPage.Portfolio]) -> some View {
        let open = portfolios.filter { $0.closedOn == nil }
        let closed = portfolios.filter { $0.closedOn != nil }
        Section {
            if portfolios.isEmpty {
                Text("Open your Pillar 3a account and add its portfolios.")
                    .foregroundStyle(.secondary)
            }
            ForEach(open + closed) { portfolio in
                portfolioRow(portfolio)
            }
        } header: {
            Text("Portfolios")
        } footer: {
            Text("Values are entered by hand on the account page.")
        }
    }

    private func portfolioSubtitle(_ portfolio: Pillar3aPage.Portfolio) -> String {
        var parts: [String] = [portfolio.accountName]
        if let strategy = portfolio.strategy, !strategy.isEmpty { parts.append(strategy) }
        if let closedOn = portfolio.closedOn { parts.append("Closed \(formats.date(closedOn))") }
        return parts.joined(separator: " · ")
    }

    private func portfolioRow(_ portfolio: Pillar3aPage.Portfolio) -> some View {
        NavigationLink(value: Route.account(portfolio.accountId)) {
            ValueRow(portfolio.name, subtitle: portfolioSubtitle(portfolio)) {
                if let value = portfolio.latestValue {
                    AmountText(value, currency)
                } else {
                    Text("no value yet").font(.caption).foregroundStyle(.secondary)
                }
                if let date = portfolio.latestValueDate {
                    Text("as of \(formats.date(date))").font(.caption2).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    Text("Contributed").foregroundStyle(.secondary)
                    AmountText(portfolio.contributed, currency)
                }
                .font(.caption)
                if let gain = portfolio.gain {
                    AmountText(gain, currency, tone: .signed, showPlus: true).font(.caption)
                }
            }
        }
    }

    // MARK: Contributions

    private func visibleContributions(_ page: Pillar3aPage) -> [Pillar3aPage.Contribution] {
        if yearFilter == "all" { return page.contributions }
        return page.contributions.filter { String($0.year) == yearFilter }
    }

    private func contributionYears(_ page: Pillar3aPage) -> [Int] {
        let unique = Set(page.contributions.map { $0.year })
        return unique.sorted(by: >)
    }

    @ViewBuilder
    private func contributionsSection(_ page: Pillar3aPage) -> some View {
        let years = contributionYears(page)
        let visible = visibleContributions(page)
        Section {
            if years.count > 1 {
                Picker("Year", selection: $yearFilter) {
                    Text("All years").tag("all")
                    ForEach(years, id: \.self) { year in
                        Text(String(year)).tag(String(year))
                    }
                }
            }
            Button {
                contributionTarget = Pillar3aContributionTarget(id: "new", contribution: nil, presetKind: nil)
            } label: {
                Label("Add contribution", systemImage: "plus")
            }
            .disabled(page.overview.portfolios.isEmpty)
            if page.overview.portfolios.isEmpty {
                Text("Add a portfolio to a Pillar 3a account first. Contributions belong to a portfolio.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if visible.isEmpty {
                Text("No contributions. Import payments that carry a portfolio's reference, or add one by hand.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(visible, id: \.key) { contribution in
                contributionRow(contribution)
            }
        } header: {
            Text("Contributions")
        } footer: {
            Text("Payments with a portfolio's reference are detected automatically. Add payments the app cannot see by hand.")
        }
    }

    private func contributionSubtitle(_ contribution: Pillar3aPage.Contribution) -> String {
        var line = "\(contribution.portfolioName) · \(contribution.source)"
        if contribution.dateOverridden, let booking = contribution.bookingDate {
            line += " · booked \(formats.date(booking))"
        }
        return line
    }

    private func buyInText(_ contribution: Pillar3aPage.Contribution) -> String {
        if contribution.gapYears.isEmpty { return "Buy-in" }
        return "Buy-in for " + Pillar3aText.yearsText(contribution.gapYears)
    }

    private func contributionRow(_ contribution: Pillar3aPage.Contribution) -> some View {
        Button {
            contributionTarget = Pillar3aContributionTarget(
                id: contribution.key,
                contribution: contribution,
                presetKind: nil
            )
        } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(formats.date(contribution.date))
                    Text(contributionSubtitle(contribution))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if contribution.kind == "buy_in" {
                        Pill(buyInText(contribution), color: .accentColor)
                    }
                    if let note = contribution.note, !note.isEmpty {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                    if let warning = contribution.lateDecemberWarning {
                        Text(warning).font(.caption).foregroundStyle(KeptColor.warning)
                    }
                }
                Spacer(minLength: 8)
                AmountText(contribution.amount, currency)
            }
        }
        .tint(.primary)
        .swipeActions {
            if contribution.source == "manual" {
                Button(role: .destructive) {
                    deleting = contribution
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } else if contribution.id != nil {
                Button {
                    deleting = contribution
                } label: {
                    Label("Reset", systemImage: "arrow.clockwise")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            Button {
                contributionTarget = Pillar3aContributionTarget(
                    id: contribution.key,
                    contribution: contribution,
                    presetKind: nil
                )
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            if contribution.kind != "buy_in" {
                Button {
                    contributionTarget = Pillar3aContributionTarget(
                        id: contribution.key + "-buy-in",
                        contribution: contribution,
                        presetKind: "buy_in"
                    )
                } label: {
                    Label("Mark as buy-in", systemImage: "arrow.left.arrow.right")
                }
            }
            if contribution.source == "manual" {
                Button(role: .destructive) {
                    deleting = contribution
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } else if contribution.id != nil {
                Button {
                    deleting = contribution
                } label: {
                    Label("Reset to ordinary", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    // MARK: Orphans

    @ViewBuilder
    private func orphansSection(_ orphans: [Pillar3aPage.Orphan]) -> some View {
        if !orphans.isEmpty {
            Section {
                ForEach(orphans) { orphan in
                    orphanRow(orphan)
                }
            } header: {
                Text("Detached annotations")
            } footer: {
                Text("These belong to payments that are no longer detected as contributions (the reference changed or the payment was refunded). They do not count as contributions. A buy-in among them keeps its gap years closed until you delete it.")
            }
        }
    }

    private func orphanText(_ orphan: Pillar3aPage.Orphan) -> String {
        let kind: String
        if orphan.kind == "buy_in" {
            let years = Pillar3aText.yearsText(orphan.gapYears)
            kind = "Buy-in for " + (years.isEmpty ? "no year" : years)
        } else {
            kind = "Ordinary"
        }
        return formats.date(orphan.date) + " · " + kind
    }

    private func orphanRow(_ orphan: Pillar3aPage.Orphan) -> some View {
        ValueRow(orphan.portfolioName, subtitle: orphanText(orphan))
            .swipeActions {
                Button(role: .destructive) {
                    deletingOrphan = orphan
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
    }

    // MARK: Actions

    private func deleteContribution(_ contribution: Pillar3aPage.Contribution) async {
        await store.submit("deleteContribution", form: Pillar3aText.deleteForm(contribution), showRefusal: true)
    }

    private func deleteOrphan(_ orphan: Pillar3aPage.Orphan) async {
        var form = FormFields()
        form.set("contributionId", orphan.id)
        await store.submit("deleteContribution", form: form, showRefusal: true)
    }
}

// MARK: - Year row

private struct Pillar3aYearRow: View {
    let year: Pillar3aPage.Year
    let thisYear: Int

    @Environment(\.formats) private var formats

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            ProgressBar(
                fraction: Pillar3aText.fraction(ordinary: year.ordinary, limit: year.limit),
                color: year.overLimit > 0 ? KeptColor.negative : Color.accentColor
            )
            progressText
            figures
            if year.overLimit > 0 {
                HStack(spacing: 4) {
                    Text("Over the limit by")
                    AmountText(year.overLimit, "CHF")
                    Text("(not deductible)")
                }
                .font(.caption)
                .foregroundStyle(KeptColor.negative)
            }
            Text(Pillar3aText.deductionLabel(year.deduction))
                .font(.caption)
                .foregroundStyle(.secondary)
            if year.settingInherited {
                Text("Carried over from the previous year until you save.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(String(year.year)).font(.headline).monospacedDigit()
            if year.closedBy != nil {
                Pill("Closed by buy-in", color: KeptColor.positive)
            } else if year.buyInEligible {
                Pill("Open gap")
            }
            if year.overLimit > 0 {
                Pill("Over the limit", color: KeptColor.negative)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
        }
    }

    private var progressText: some View {
        HStack(spacing: 4) {
            Text("Paid")
            AmountText(year.ordinary, "CHF")
            Text("of")
            AmountText(year.limit, "CHF")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var figures: some View {
        HStack(alignment: .top) {
            figure("Ordinary", year.ordinary)
            figure("Buy-in", year.buyIn)
            if year.closedBy != nil {
                VStack(alignment: .leading, spacing: 2) {
                    Text(gapLabel).font(.caption).foregroundStyle(.secondary)
                    Text("Closed").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                figure(gapLabel, year.gap)
            }
        }
        if year.limitUnconfirmed {
            Text(Pillar3aText.limitHint(deduction: year.deduction, earnedIncome: year.earnedIncome))
                .font(.caption)
                .foregroundStyle(KeptColor.warning)
        }
    }

    private var gapLabel: String {
        year.year < thisYear ? "Gap" : "Room left"
    }

    private func figure(_ label: String, _ amount: Int64) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            AmountText(amount, "CHF").font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Year form

private struct Pillar3aYearSheet: View {
    let store: PageStore<Pillar3aPage>
    let year: Pillar3aPage.Year

    @State private var deduction: String
    @State private var income: String

    init(store: PageStore<Pillar3aPage>, year: Pillar3aPage.Year) {
        self.store = store
        self.year = year
        _deduction = State(initialValue: year.deduction)
        var text = ""
        if let value = year.earnedIncome { text = Formats.amountInput(value, "CHF") }
        _income = State(initialValue: text)
    }

    var body: some View {
        FormSheet(
            "Deduction for \(year.year)",
            busy: store.busy,
            error: store.formErrors["form"]
        ) {
            return await save()
        } content: {
            Section {
                Picker("Deduction", selection: $deduction) {
                    ForEach(Pillar3aText.deductions, id: \.self) { value in
                        Text(Pillar3aText.deductionLabel(value)).tag(value)
                    }
                }
                FieldError(store.formErrors["deduction"])
                if deduction == "large" {
                    AmountField("Net earned income", text: $income, currency: "CHF")
                    FieldError(store.formErrors["earnedIncome"])
                }
            } footer: {
                if year.settingInherited {
                    Text("Carried over from the previous year until you save.")
                }
            }
        }
    }

    private func save() async -> Bool {
        let form = Pillar3aText.yearForm(year: year.year, deduction: deduction, earnedIncome: income)
        let result = await store.submit("setYear", form: form)
        return result != nil
    }
}

// MARK: - Contribution form

private struct Pillar3aContributionSheet: View {
    let store: PageStore<Pillar3aPage>
    let contribution: Pillar3aPage.Contribution?
    let portfolios: [Pillar3aPage.Portfolio]
    let gaps: [Pillar3aPage.Gap]

    @State private var kind: String
    @State private var date: String
    @State private var amount: String
    @State private var portfolioId: String
    @State private var selectedYears: [Int]
    @State private var note: String
    @State private var check: Pillar3aBuyInCheck?
    @State private var checking = false
    @State private var checkFailed = false
    @Environment(\.formats) private var formats

    init(
        store: PageStore<Pillar3aPage>,
        contribution: Pillar3aPage.Contribution?,
        presetKind: String?,
        portfolios: [Pillar3aPage.Portfolio],
        gaps: [Pillar3aPage.Gap]
    ) {
        self.store = store
        self.contribution = contribution
        self.portfolios = portfolios
        self.gaps = gaps
        _kind = State(initialValue: presetKind ?? contribution?.kind ?? "ordinary")
        _date = State(initialValue: contribution?.date ?? Formats.isoDate(Date()))
        var amountText = ""
        if let contribution { amountText = Formats.amountInput(contribution.amount, "CHF") }
        _amount = State(initialValue: amountText)
        _portfolioId = State(initialValue: contribution?.portfolioId ?? portfolios.first?.portfolioId ?? "")
        _selectedYears = State(initialValue: contribution?.gapYears ?? [])
        _note = State(initialValue: contribution?.note ?? "")
    }

    private var detected: Bool { contribution?.source == "detected" }

    /// Gap years this buy-in may still close: open ones, plus those it holds.
    private var candidates: [Pillar3aPage.Gap] {
        gaps.filter { gap in
            guard let closer = gap.closedBy else { return true }
            if let own = contribution?.id, own == closer { return true }
            return false
        }
    }

    private var checkKey: String {
        let years = Pillar3aText.yearsText(selectedYears, separator: ",")
        return "\(kind)|\(date)|\(amount)|\(years)"
    }

    var body: some View {
        FormSheet(
            contribution == nil ? "Add contribution" : "Edit contribution",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: contribution == nil ? "Add" : "Save",
            submitDisabled: portfolios.isEmpty
        ) {
            return await save()
        } content: {
            mainSection
            if kind == "buy_in" {
                buyInSection
            }
            noteSection
        }
        .task(id: checkKey) {
            await runCheck()
        }
    }

    // MARK: Sections

    @ViewBuilder
    private var mainSection: some View {
        Section {
            if detected, let contribution {
                LabeledContent(contribution.portfolioName) {
                    AmountText(contribution.amount, "CHF").fontWeight(.semibold)
                }
            } else {
                Picker("Portfolio", selection: $portfolioId) {
                    ForEach(portfolios) { portfolio in
                        Text(portfolio.name + " · " + portfolio.accountName).tag(portfolio.portfolioId)
                    }
                }
                FieldError(store.formErrors["portfolioId"])
                AmountField("Amount", text: $amount, currency: "CHF")
                FieldError(store.formErrors["amount"])
            }
            DateField("Credit date", value: $date)
            FieldError(store.formErrors["date"])
            Picker("Type", selection: $kind) {
                Text("Ordinary").tag("ordinary")
                Text("Buy-in").tag("buy_in")
            }
            FieldError(store.formErrors["kind"])
        } footer: {
            Text(detected
                ? "Detected from a payment. The amount comes from the payment; set the date it was credited if it differs. The year it was credited sets the tax year."
                : "Record a payment the app cannot see, e.g. one from an account you do not track. The year it was credited sets the tax year.")
        }
    }

    @ViewBuilder
    private var buyInSection: some View {
        Section {
            if candidates.isEmpty {
                Text("No open gap years. Buy-ins can close gaps from 2025 on, for years before the current one.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(candidates) { gap in
                Toggle(isOn: yearBinding(gap.year)) {
                    gapLabel(gap)
                }
            }
            FieldError(store.formErrors["gapYears"])
            checkRows
        } header: {
            Text("Gap years to close")
        }
    }

    private func gapLabel(_ gap: Pillar3aPage.Gap) -> some View {
        HStack(spacing: 6) {
            Text(String(gap.year)).monospacedDigit()
            Text("gap").font(.caption).foregroundStyle(.secondary)
            AmountText(gap.gap, "CHF").font(.caption)
        }
    }

    @ViewBuilder
    private var checkRows: some View {
        if checking {
            Text("Checking the buy-in rules").font(.caption).foregroundStyle(.secondary)
        }
        if checkFailed {
            Text("Could not check the buy-in rules. Saving still validates them.")
                .font(.footnote)
                .foregroundStyle(KeptColor.negative)
        }
        if let check {
            ForEach(Array(check.errors.enumerated()), id: \.offset) { _, message in
                Label(message, systemImage: "xmark.circle")
                    .font(.footnote)
                    .foregroundStyle(KeptColor.negative)
            }
            ForEach(Array(check.warnings.enumerated()), id: \.offset) { _, message in
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(KeptColor.warning)
            }
        }
    }

    @ViewBuilder
    private var noteSection: some View {
        Section {
            TextField("Note (optional)", text: $note)
            FieldError(store.formErrors["note"])
        }
    }

    // MARK: Logic

    private func yearBinding(_ year: Int) -> Binding<Bool> {
        Binding(
            get: { selectedYears.contains(year) },
            set: { on in
                var years = selectedYears.filter { $0 != year }
                if on { years.append(year) }
                selectedYears = years
            }
        )
    }

    private func runCheck() async {
        if kind != "buy_in" {
            check = nil
            checkFailed = false
            checking = false
            return
        }
        do {
            try await Task.sleep(for: .milliseconds(300))
        } catch {
            return
        }
        checking = true
        let query = Pillar3aText.checkQuery(
            date: date,
            amount: amount.trimmingCharacters(in: .whitespaces),
            gapYears: selectedYears,
            key: contribution?.key
        )
        do {
            let result = try await SDKClient.shared.endpoint(
                "pillar-3a/buy-in-check",
                query: query,
                as: Pillar3aBuyInCheck.self
            )
            check = result
            checkFailed = false
        } catch let error as KeptError {
            // A refused request means incomplete input (a half-typed date): nothing to check yet.
            check = nil
            checkFailed = error.kind != .rejected
        } catch {
            // Cancelled by a newer input: leave the state to the newer check.
            return
        }
        checking = false
    }

    private func save() async -> Bool {
        let form = Pillar3aText.contributionForm(
            contribution: contribution,
            portfolioId: portfolioId,
            amount: amount,
            date: date,
            kind: kind,
            gapYears: selectedYears,
            note: note
        )
        let action = contribution == nil ? "addContribution" : "updateContribution"
        guard let result = await store.submit(action, form: form) else { return false }
        if let saved = try? result.decode(Pillar3aSaved.self), let warnings = saved.warnings, !warnings.isEmpty {
            store.message = warnings.joined(separator: "\n")
        }
        return true
    }
}
