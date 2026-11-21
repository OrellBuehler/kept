import SwiftUI

/// Holdings and trades of an investment account.
struct AccountHoldingsSection: View {
    let page: AccountPage
    let valuation: AccountPage.Valuation
    @Binding var sheet: AccountDetailSheet?
    @Binding var confirm: AccountDetailConfirm?

    @Environment(\.formats) private var formats

    var body: some View {
        positions
        trades
    }

    // MARK: Positions

    private var positions: some View {
        Section {
            if valuation.positions.isEmpty {
                Text("No holdings. Record your buys and sells to see what this account holds and what it is worth.")
                    .foregroundStyle(.secondary)
            }
            ForEach(valuation.positions) { position in
                positionRow(position)
            }
        } header: {
            Text("Holdings")
        } footer: {
            Text("What you hold, valued at the latest price. The account total is the cash balance plus these holdings.")
        }
    }

    private func quantityText(_ value: Int64) -> String {
        return AccountsFixed.display(value, locale: formats.locale)
    }

    private func unitText(_ value: Int64) -> String {
        return AccountsFixed.display(value, locale: formats.locale, minFraction: 2)
    }

    private func positionRow(_ position: AccountPage.Position) -> some View {
        let quantity = quantityText(position.quantity)
        let price = unitText(position.price)
        let source = AccountsLogic.priceSourceLabel(position.priceSource)
        var subtitle = "\(quantity) \u{00D7} \(price) \(position.currency)"
        if let date = position.priceDate {
            subtitle += "\n\(formats.date(date)) \u{00B7} \(source)"
        }
        return ValueRow(position.name, subtitle: subtitle) {
            AmountText(position.value, page.account.currency)
            if position.estimated {
                Pill("estimated")
            } else {
                AmountText(position.gain, page.account.currency, tone: .signed, showPlus: true)
                    .font(.caption)
            }
        }
    }

    // MARK: Trades

    private var trades: some View {
        Section {
            if page.trades.isEmpty {
                Text("No trades. Trades do not create cash transactions: your imported statements already contain the cash side.")
                    .foregroundStyle(.secondary)
            }
            ForEach(page.trades) { trade in
                tradeRow(trade)
            }
            Button {
                sheet = .addTrade
            } label: {
                Label("Add trade", systemImage: "plus")
            }
        } header: {
            Text("Trades")
        } footer: {
            if !page.snapshots.isEmpty && !page.trades.isEmpty {
                Text("Balance snapshots now count as the cash balance only. A snapshot that recorded the total value, holdings included, counts them twice: remove it or replace it with the cash balance.")
            }
        }
    }

    private func tradeSubtitle(_ trade: AccountPage.Trade) -> String {
        let date = formats.date(trade.date)
        if trade.side == "split" {
            let terms = AccountsLogic.splitTerms(quantity: trade.quantity, splitNew: trade.splitNew, splitOld: trade.splitOld)
            if let terms { return "\(date) \u{00B7} split \(terms.new) : \(terms.old)" }
            return "\(date) \u{00B7} split \u{00D7}\(quantityText(trade.quantity))"
        }
        let quantity = quantityText(trade.quantity)
        let price = unitText(trade.price)
        return "\(date) \u{00B7} \(quantity) \u{00D7} \(price) \(trade.securityCurrency)"
    }

    private func tradeRow(_ trade: AccountPage.Trade) -> some View {
        Button {
            sheet = .editTrade(trade.id)
        } label: {
            ValueRow("\(AccountsLogic.sideLabel(trade.side)) \(trade.securityName)", subtitle: tradeSubtitle(trade)) {
                if trade.side != "split" {
                    AmountText(trade.amount, page.account.currency)
                }
                if trade.fees > 0 {
                    HStack(spacing: 3) {
                        Text("incl.")
                        AmountText(trade.fees, page.account.currency)
                        Text("fees")
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .tint(.primary)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                confirm = deleteConfirm(trade)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func deleteConfirm(_ trade: AccountPage.Trade) -> AccountDetailConfirm {
        var what = "The purchase of \(trade.securityName)"
        if trade.side == "sell" { what = "The sale of \(trade.securityName)" }
        if trade.side == "split" { what = "The split of \(trade.securityName)" }
        return AccountDetailConfirm(
            action: "deleteTrade",
            field: "tradeId",
            targetId: trade.id,
            title: "Delete this trade?",
            message: "\(what) on \(formats.date(trade.date)) will be removed and the holdings recalculated. Your transactions are not affected.",
            button: "Delete"
        )
    }
}

/// Add or edit a trade: a buy, a sell or a split ("addTrade", "updateTrade").
struct AccountTradeSheet: View {
    let store: PageStore<AccountPage>
    let page: AccountPage
    let trade: AccountPage.Trade?

    @Environment(\.dismiss) private var dismiss
    @Environment(Router.self) private var router
    @State private var securityId: String
    @State private var side: String
    @State private var date: String
    @State private var quantity: String
    @State private var splitNew: String
    @State private var splitOld: String
    @State private var price: String
    @State private var fees: String
    @State private var amount: String
    @State private var amountTouched: Bool
    @State private var note: String

    init(store: PageStore<AccountPage>, page: AccountPage, trade: AccountPage.Trade?) {
        self.store = store
        self.page = page
        self.trade = trade
        let currency = page.account.currency
        _securityId = State(initialValue: trade?.securityId ?? page.securities.first?.id ?? "")
        _side = State(initialValue: trade?.side ?? "buy")
        _date = State(initialValue: trade?.date ?? Formats.isoDate(Date()))
        var quantityText = ""
        var newText = ""
        var oldText = ""
        var priceText = ""
        var feesText = ""
        var amountText = ""
        if let trade {
            if trade.side == "split" {
                let terms = AccountsLogic.splitTerms(quantity: trade.quantity, splitNew: trade.splitNew, splitOld: trade.splitOld)
                if let terms {
                    newText = String(terms.new)
                    oldText = String(terms.old)
                } else {
                    quantityText = AccountsFixed.input(trade.quantity)
                }
            } else {
                quantityText = AccountsFixed.input(trade.quantity)
                priceText = AccountsFixed.input(trade.price)
                if trade.fees != 0 { feesText = Formats.amountInput(trade.fees, currency) }
                amountText = Formats.amountInput(trade.amount, currency)
            }
        }
        _quantity = State(initialValue: quantityText)
        _splitNew = State(initialValue: newText)
        _splitOld = State(initialValue: oldText)
        _price = State(initialValue: priceText)
        _fees = State(initialValue: feesText)
        _amount = State(initialValue: amountText)
        _amountTouched = State(initialValue: trade != nil)
        _note = State(initialValue: trade?.note ?? "")
    }

    private var isSplit: Bool { side == "split" }
    private var security: AccountPage.SecurityItem? { page.securities.first(where: { $0.id == securityId }) }
    private var sameCurrency: Bool { security?.currency == page.account.currency }
    private var suggestionKey: String { "\(quantity)|\(price)|\(fees)|\(securityId)|\(side)" }

    private var amountBinding: Binding<String> {
        Binding(
            get: { amount },
            set: { value in
                amount = value
                amountTouched = true
            }
        )
    }

    var body: some View {
        FormSheet(
            trade == nil ? "Add trade" : "Edit trade",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: trade == nil ? "Add" : "Save",
            submitDisabled: page.securities.isEmpty
        ) {
            await save()
        } content: {
            if page.securities.isEmpty {
                noSecurities
            } else {
                securitySection
                if isSplit { splitSection } else { cashSection }
            }
            Section {
                TextField("Note (optional)", text: $note)
                FieldError(store.formErrors["note"])
            }
        }
        .onChange(of: suggestionKey) { _, _ in
            refreshSuggestion()
        }
    }

    private var noSecurities: some View {
        Section {
            Text("Add the security you traded first.")
            Button("Open Investments") {
                dismiss()
                router.push(.investments)
            }
        }
    }

    private var securitySection: some View {
        Section {
            Picker("Security", selection: $securityId) {
                ForEach(page.securities) { item in
                    Text("\(item.name) (\(item.currency))").tag(item.id)
                }
            }
            FieldError(store.formErrors["securityId"])
            DateField("Date", value: $date)
            FieldError(store.formErrors["date"])
            Picker("Side", selection: $side) {
                ForEach(AccountsLogic.tradeSides, id: \.value) { entry in
                    Text(entry.label).tag(entry.value)
                }
            }
            .pickerStyle(.segmented)
            FieldError(store.formErrors["side"])
        } footer: {
            Text(isSplit
                ? "A split changes the number of shares you hold, not what you paid."
                : "A trade changes the holdings, not the cash. Kept does not create a cash transaction for it.")
        }
    }

    private var splitSection: some View {
        Section {
            HStack(spacing: 8) {
                TextField("New", text: $splitNew).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                Text(":")
                TextField("Old", text: $splitOld).keyboardType(.numberPad)
            }
            FieldError(store.formErrors["splitNew"])
            FieldError(store.formErrors["splitOld"])
            FieldError(store.formErrors["quantity"])
        } header: {
            Text("Split (new : old)")
        } footer: {
            Text("Whole numbers: 2 : 1 for a 2-for-1 split, 1 : 3 for a 1-for-3 reverse split. Applies from this date.")
        }
    }

    private var cashSection: some View {
        let currency = page.account.currency
        let securityCurrency = security?.currency ?? ""
        return Section {
            AmountField("Quantity", text: $quantity)
            FieldError(store.formErrors["quantity"])
            AmountField("Price per unit", text: $price, currency: securityCurrency)
            FieldError(store.formErrors["price"])
            AmountField("Fees (optional)", text: $fees, currency: currency)
            FieldError(store.formErrors["fees"])
            AmountField("Amount incl. fees", text: amountBinding, currency: currency)
            FieldError(store.formErrors["amount"])
        } footer: {
            Text(sameCurrency
                ? "Quantity up to 8 decimals. The amount is cash paid or received including fees, filled in until you change it."
                : "Quantity up to 8 decimals. The amount is cash paid or received including fees, in your account's currency, as on your statement.")
        }
    }

    private func refreshSuggestion() {
        if amountTouched || !sameCurrency || isSplit { return }
        let suggestion = AccountsFixed.suggestedAmount(
            quantity: quantity,
            price: price,
            fees: fees,
            side: side,
            currency: page.account.currency
        )
        if let suggestion { amount = suggestion }
    }

    private func save() async -> Bool {
        var form = FormFields()
        if let trade { form.set("tradeId", trade.id) }
        form.set("securityId", securityId)
        form.set("side", side)
        form.set("date", date)
        form.set("note", note)
        if isSplit {
            form.set("splitNew", splitNew)
            form.set("splitOld", splitOld)
        } else {
            form.set("quantity", quantity)
            form.set("price", price)
            form.set("fees", fees)
            form.set("amount", amount)
        }
        let action = trade == nil ? "addTrade" : "updateTrade"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}
