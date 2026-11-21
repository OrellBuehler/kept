import SwiftUI

/// Which security the form sheet edits; `security == nil` adds one.
struct InvestmentsFormTarget: Identifiable {
    let id: String
    let security: InvestmentsPage.Security?
}

/// The portfolio: value, cost and gain per currency, the positions by security, and the securities themselves.
struct InvestmentsView: View {
    @State private var store = PageStore<InvestmentsPage>(path: "investments")
    @State private var formTarget: InvestmentsFormTarget?
    @State private var deleting: InvestmentsPage.Security?
    @State private var showHistory = false
    @Environment(\.formats) private var formats
    @Environment(\.session) private var session

    var body: some View {
        PageView("Investments", store: store) { page in
            content(page)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    formTarget = InvestmentsFormTarget(id: "new", security: nil)
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add security")
            }
        }
        .sheet(item: $formTarget) { target in
            InvestmentsSecuritySheet(
                store: store,
                security: target.security,
                defaultCurrency: session?.preferences.defaultCurrency ?? "CHF",
                canLookup: store.state.value?.marketData.canLookup ?? false,
                lookupEnabled: store.state.value?.marketData.enabled ?? false
            )
        }
        .sheet(isPresented: $showHistory, onDismiss: { closeHistory() }) {
            InvestmentsPriceSheet(store: store)
        }
        .confirmationDialog(
            "Delete this security?",
            isPresented: deleteBinding,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let security = deleting {
                    Task { await deleteSecurity(security) }
                }
            }
        } message: {
            Text("The security and its price history are removed. This is not possible while it has trades.")
        }
    }

    private var deleteBinding: Binding<Bool> {
        Binding(
            get: { deleting != nil },
            set: { value in
                if !value { deleting = nil }
            }
        )
    }

    @ViewBuilder
    private func content(_ page: InvestmentsPage) -> some View {
        if page.securities.isEmpty {
            ContentUnavailableView {
                Label("No securities yet", systemImage: "chart.line.uptrend.xyaxis")
            } description: {
                Text("Add the ETFs, stocks and funds you hold, then record your trades on the investment account's page.")
            } actions: {
                Button("Add security") {
                    formTarget = InvestmentsFormTarget(id: "new", security: nil)
                }
                .buttonStyle(.borderedProminent)
            }
        } else {
            List {
                totalsSections(page.overview.totals)
                positionsSection(page.overview.securities)
                securitiesSection(page.securities)
            }
        }
    }

    // MARK: Totals

    @ViewBuilder
    private func totalsSections(_ totals: [InvestmentsPage.Total]) -> some View {
        ForEach(totals) { total in
            Section {
                LabeledContent("Value") {
                    AmountText(total.value, total.currency).font(.title3.weight(.semibold))
                }
                LabeledContent("Cost") { AmountText(total.cost, total.currency) }
                LabeledContent("Gain") {
                    AmountText(total.gain, total.currency, tone: .signed, showPlus: true)
                }
            } header: {
                HStack {
                    Text("Holdings in \(total.currency)")
                    if total.estimated {
                        Pill("estimated", color: KeptColor.warning)
                    }
                }
            } footer: {
                if total.estimated {
                    Text("Some positions are valued at cost because an exchange rate is missing.")
                }
            }
        }
    }

    // MARK: Positions

    @ViewBuilder
    private func positionsSection(_ groups: [InvestmentsPage.Group]) -> some View {
        Section {
            if groups.isEmpty {
                Text("Add a trade on an investment account to see your positions here.")
                    .foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                groupRow(group)
                if group.positions.count > 1 {
                    ForEach(group.positions) { position in
                        positionRow(position)
                    }
                }
            }
        } header: {
            Text("Positions")
        } footer: {
            Text("Grouped by security. Values are in each account's currency.")
        }
    }

    private func groupSubtitle(_ group: InvestmentsPage.Group) -> String {
        let quantity = InvestmentsText.format(group.quantity, locale: formats.locale)
        let price = InvestmentsText.format(group.price, locale: formats.locale, minFraction: 2)
        let source = InvestmentsText.sourceLabel(group.priceSource)
        let date = formats.date(group.priceDate)
        return "\(quantity) × \(price) \(group.currency)\n\(date) · \(source)"
    }

    private func groupRow(_ group: InvestmentsPage.Group) -> some View {
        ValueRow(group.name, subtitle: groupSubtitle(group)) {
            ForEach(group.totals) { total in
                AmountText(total.value, total.currency)
                if total.estimated {
                    Text("–").font(.caption).foregroundStyle(.secondary)
                } else {
                    AmountText(total.gain, total.currency, tone: .signed, showPlus: true)
                        .font(.caption)
                }
            }
        }
    }

    private func positionSubtitle(_ position: InvestmentsPage.Position) -> String {
        let quantity = InvestmentsText.format(position.quantity, locale: formats.locale)
        if let institution = position.institutionName, !institution.isEmpty {
            return "\(institution) · \(quantity)"
        }
        return quantity
    }

    private func positionRow(_ position: InvestmentsPage.Position) -> some View {
        NavigationLink(value: Route.account(position.accountId)) {
            ValueRow(position.accountName, subtitle: positionSubtitle(position)) {
                AmountText(position.value, position.accountCurrency)
                if position.estimated {
                    Text("–").font(.caption).foregroundStyle(.secondary)
                } else {
                    AmountText(position.gain, position.accountCurrency, tone: .signed, showPlus: true)
                        .font(.caption)
                }
            }
        }
        .font(.footnote)
        .padding(.leading, 12)
    }

    // MARK: Securities

    @ViewBuilder
    private func securitiesSection(_ securities: [InvestmentsPage.Security]) -> some View {
        Section {
            ForEach(securities) { security in
                securityRow(security)
            }
        } header: {
            Text("Securities")
        } footer: {
            Text("Prices come from the market data provider or from you. Tap a security for its price history; set a price by hand where there is no symbol.")
        }
    }

    private func securitySubtitle(_ security: InvestmentsPage.Security) -> String {
        var parts: [String] = []
        if let isin = security.isin, !isin.isEmpty { parts.append(isin) }
        if let symbol = security.symbol, !symbol.isEmpty { parts.append(symbol) }
        parts.append(security.currency)
        return parts.joined(separator: " · ")
    }

    private func securityRow(_ security: InvestmentsPage.Security) -> some View {
        Button {
            Task { await openHistory(security) }
        } label: {
            ValueRow(security.name, subtitle: securitySubtitle(security)) {
                Pill(InvestmentsText.kindLabel(security.kind))
            }
        }
        .tint(.primary)
        .swipeActions {
            Button(role: .destructive) {
                deleting = security
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                formTarget = InvestmentsFormTarget(id: security.id, security: security)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            .tint(.accentColor)
        }
        .contextMenu {
            Button {
                formTarget = InvestmentsFormTarget(id: security.id, security: security)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = security
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    // MARK: Actions

    private func openHistory(_ security: InvestmentsPage.Security) async {
        store.query["prices"] = security.id
        store.query["all"] = nil
        await store.load()
        let loaded = store.state.value?.priceHistory != nil
        if loaded {
            showHistory = true
        } else {
            store.query["prices"] = nil
        }
    }

    private func closeHistory() {
        store.query["prices"] = nil
        store.query["all"] = nil
        Task { await store.load() }
    }

    private func deleteSecurity(_ security: InvestmentsPage.Security) async {
        var form = FormFields()
        form.set("securityId", security.id)
        await store.submit("deleteSecurity", form: form, showRefusal: true)
    }
}

// MARK: - Security form

private struct InvestmentsSecuritySheet: View {
    let store: PageStore<InvestmentsPage>
    let security: InvestmentsPage.Security?
    let canLookup: Bool
    let lookupEnabled: Bool

    @State private var name: String
    @State private var kind: String
    @State private var isin: String
    @State private var symbol: String
    @State private var currency: String
    @State private var query = ""
    @State private var searching = false
    @State private var matches: [InvestmentsLookupResult.Match]?

    init(
        store: PageStore<InvestmentsPage>,
        security: InvestmentsPage.Security?,
        defaultCurrency: String,
        canLookup: Bool,
        lookupEnabled: Bool
    ) {
        self.store = store
        self.security = security
        self.canLookup = canLookup
        self.lookupEnabled = lookupEnabled
        _name = State(initialValue: security?.name ?? "")
        _kind = State(initialValue: security?.kind ?? "etf")
        _isin = State(initialValue: security?.isin ?? "")
        _symbol = State(initialValue: security?.symbol ?? "")
        _currency = State(initialValue: security?.currency ?? defaultCurrency)
    }

    var body: some View {
        FormSheet(
            security == nil ? "Add security" : "Edit security",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: security == nil ? "Add" : "Save",
            submitDisabled: name.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            return await save()
        } content: {
            lookupSection
            fieldsSection
        }
    }

    @ViewBuilder
    private var lookupSection: some View {
        if canLookup {
            Section {
                TextField("ISIN or name", text: $query)
                    .autocorrectionDisabled()
                Button("Search") {
                    Task { await search() }
                }
                .disabled(searching || query.trimmingCharacters(in: .whitespaces).count < 2)
                FieldError(store.formErrors["q"])
                matchRows
            } header: {
                Text("Look up")
            } footer: {
                Text("Sends your search text to the market data provider.")
            }
        } else {
            Section {
                Text(lookupEnabled
                    ? "No market data provider is available, so symbols are entered by hand."
                    : "Turn on market data in Settings to look up securities by ISIN or name.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var matchRows: some View {
        if let matches {
            if matches.isEmpty {
                Text("No matches.").foregroundStyle(.secondary)
            }
            ForEach(matches) { match in
                Button {
                    pick(match)
                } label: {
                    ValueRow(match.name, subtitle: match.symbol) {
                        if let kind = match.kind {
                            Pill(InvestmentsText.kindLabel(kind))
                        }
                    }
                }
                .tint(.primary)
            }
        }
    }

    @ViewBuilder
    private var fieldsSection: some View {
        Section {
            TextField("Name", text: $name)
            FieldError(store.formErrors["name"])
            Picker("Type", selection: $kind) {
                ForEach(InvestmentsText.kinds, id: \.self) { value in
                    Text(InvestmentsText.kindLabel(value)).tag(value)
                }
            }
            FieldError(store.formErrors["kind"])
            TextField("Currency (e.g. CHF)", text: $currency)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["currency"])
            TextField("ISIN (optional)", text: $isin)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["isin"])
            TextField("Symbol (optional)", text: $symbol)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["symbol"])
        } footer: {
            Text("An ETF, stock or fund you hold. Without a symbol, prices are entered by hand. The currency is the one prices are quoted in.")
        }
    }

    private func pick(_ match: InvestmentsLookupResult.Match) {
        name = match.name
        symbol = match.symbol
        if let value = match.kind { kind = value }
        if let value = match.isin { isin = value }
        if let value = match.currency { currency = value }
        matches = nil
    }

    private func search() async {
        searching = true
        var form = FormFields()
        form.set("q", query.trimmingCharacters(in: .whitespaces))
        let result = await store.submit("lookup", form: form, reload: false)
        searching = false
        guard let result else {
            matches = nil
            return
        }
        do {
            matches = try result.decode(InvestmentsLookupResult.self).matches
        } catch {
            matches = nil
            store.message = error.localizedDescription
        }
    }

    private func save() async -> Bool {
        var form = FormFields()
        form.set("name", name)
        form.set("kind", kind)
        form.set("isin", isin)
        form.set("symbol", symbol)
        form.set("currency", currency)
        if let security { form.set("securityId", security.id) }
        let action = security == nil ? "createSecurity" : "updateSecurity"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}

// MARK: - Price history

private struct InvestmentsPriceSheet: View {
    @Bindable var store: PageStore<InvestmentsPage>

    @State private var date = Formats.isoDate(Date())
    @State private var price = ""
    @State private var deleting: InvestmentsPage.Price?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.formats) private var formats

    init(store: PageStore<InvestmentsPage>) {
        self.store = store
    }

    var body: some View {
        NavigationStack {
            Group {
                if let history = store.state.value?.priceHistory {
                    list(history)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(store.state.value?.priceHistory?.security.name ?? "Prices")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .messageAlert($store.message)
        .confirmationDialog(
            "Delete this price?",
            isPresented: deleteBinding,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let target = deleting {
                    Task { await deletePrice(target) }
                }
            }
        } message: {
            Text("The manual price will be removed. A fetched price for that day, if any, applies again.")
        }
    }

    private var deleteBinding: Binding<Bool> {
        Binding(
            get: { deleting != nil },
            set: { value in
                if !value { deleting = nil }
            }
        )
    }

    private func list(_ history: InvestmentsPage.PriceHistory) -> some View {
        List {
            setPriceSection(history)
            historySection(history)
        }
    }

    @ViewBuilder
    private func setPriceSection(_ history: InvestmentsPage.PriceHistory) -> some View {
        Section {
            DateField("Date", value: $date)
            FieldError(store.formErrors["date"])
            AmountField("Price", text: $price, currency: history.security.currency)
            FieldError(store.formErrors["price"])
            FieldError(store.formErrors["form"])
            Button("Set price") {
                Task { await setPrice(history.security) }
            }
            .disabled(store.busy || price.trimmingCharacters(in: .whitespaces).isEmpty)
        } header: {
            Text("Set a price")
        } footer: {
            Text("A manual price wins over a fetched one on the same day.")
        }
    }

    @ViewBuilder
    private func historySection(_ history: InvestmentsPage.PriceHistory) -> some View {
        Section {
            if history.prices.isEmpty {
                Text("No prices yet. Until you set one, the last trade price is used.")
                    .foregroundStyle(.secondary)
            }
            ForEach(history.prices) { item in
                priceRow(item)
            }
            if history.total > history.prices.count {
                Button("Show all \(history.total) prices") {
                    store.query["all"] = "1"
                    Task { await store.load() }
                }
            }
        } header: {
            Text("Price history in \(history.security.currency)")
        }
    }

    private func priceRow(_ item: InvestmentsPage.Price) -> some View {
        let text = InvestmentsText.format(item.price, locale: formats.locale, minFraction: 2)
        return ValueRow(formats.date(item.date), subtitle: InvestmentsText.sourceLabel(item.source)) {
            Text(text).monospacedDigit()
        }
        .swipeActions {
            if item.source == "manual" {
                Button(role: .destructive) {
                    deleting = item
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }

    private func setPrice(_ security: InvestmentsPage.Security) async {
        var form = FormFields()
        form.set("securityId", security.id)
        form.set("date", date)
        form.set("price", price.trimmingCharacters(in: .whitespaces))
        let result = await store.submit("setPrice", form: form)
        if result != nil { price = "" }
    }

    private func deletePrice(_ item: InvestmentsPage.Price) async {
        var form = FormFields()
        form.set("priceId", item.id)
        await store.submit("deletePrice", form: form, showRefusal: true)
    }
}
