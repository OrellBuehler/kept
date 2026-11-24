import SwiftUI

/// An institution to choose in the account form.
struct AccountFormInstitution: Identifiable {
    let id: String
    let name: String
}

/// Add or edit an institution (name, BIC, website, colour). The logo is uploaded in the browser.
struct AccountsInstitutionSheet: View {
    let store: PageStore<AccountsPage>
    let institution: AccountsPage.Institution?

    @State private var name: String
    @State private var bic: String
    @State private var websiteUrl: String
    @State private var color: String

    private static let palette: [String] = [
        "#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777", "#7c3aed", "#64748b",
    ]

    init(store: PageStore<AccountsPage>, institution: AccountsPage.Institution?) {
        self.store = store
        self.institution = institution
        _name = State(initialValue: institution?.name ?? "")
        _bic = State(initialValue: institution?.bic ?? "")
        _websiteUrl = State(initialValue: institution?.websiteUrl ?? "")
        _color = State(initialValue: institution?.color ?? "")
    }

    var body: some View {
        FormSheet(
            institution == nil ? "Add institution" : "Edit institution",
            busy: store.busy,
            error: store.formErrors["form"],
            submitDisabled: name.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            await save()
        } content: {
            Section {
                TextField("Name", text: $name)
                FieldError(store.formErrors["name"])
                TextField("BIC (optional)", text: $bic)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["bic"])
            }
            Section {
                TextField("Website (optional)", text: $websiteUrl)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["websiteUrl"])
            } footer: {
                Text("Link to the e-banking or provider portal.")
            }
            Section("Colour") {
                colors
                FieldError(store.formErrors["color"])
            }
        }
    }

    private var colors: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 36))], spacing: 10) {
            colorButton("")
            ForEach(Self.palette, id: \.self) { hex in
                colorButton(hex)
            }
        }
        .padding(.vertical, 4)
    }

    private func colorButton(_ hex: String) -> some View {
        let fill: Color = Color(hex: hex) ?? Color.secondary.opacity(0.25)
        return Button {
            color = hex
        } label: {
            ZStack {
                Circle().fill(fill).frame(width: 28, height: 28)
                if hex.isEmpty {
                    Image(systemName: "xmark").font(.caption).foregroundStyle(.secondary)
                }
                if color == hex {
                    Circle().stroke(Color.primary, lineWidth: 2).frame(width: 34, height: 34)
                }
            }
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(hex.isEmpty ? "No colour" : "Colour \(hex)")
    }

    private func save() async -> Bool {
        var form = FormFields()
        form.set("name", name)
        form.set("bic", bic)
        form.set("websiteUrl", websiteUrl)
        form.set("color", color)
        var action = "createInstitution"
        if let institution {
            action = "updateInstitution"
            form.set("id", institution.id)
        }
        let result = await store.submit(action, form: form)
        return result != nil
    }
}

/// Add or edit an account: the form of "createAccount" and "updateAccount".
struct AccountFormSheet<Page: Decodable & Sendable>: View {
    let store: PageStore<Page>
    let action: String
    let institutions: [AccountFormInstitution]
    let account: AccountsPage.Account?
    let currencyLocked: Bool
    let mirrorCount: Int?
    let hasPortfolios: Bool
    let hasTrades: Bool

    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var institutionId: String
    @State private var type: String
    @State private var currency: String
    @State private var iban: String
    @State private var contractNumber: String
    @State private var depositIban: String
    @State private var websiteUrl: String
    @State private var openingBalance: String
    @State private var openingDate: String
    @State private var share: String
    @State private var sharedWith: String
    @State private var noticeMonths: String
    @State private var freeWithdrawal: String
    @State private var period: String
    @State private var fill: Bool
    @State private var tradesCash: Bool
    @State private var confirmOff = false
    @State private var confirmedOff = false

    init(
        store: PageStore<Page>,
        action: String,
        institutions: [AccountFormInstitution],
        account: AccountsPage.Account?,
        defaultInstitutionId: String = "",
        defaultCurrency: String = "CHF",
        currencyLocked: Bool = false,
        mirrorCount: Int? = nil,
        hasPortfolios: Bool = false,
        hasTrades: Bool = false
    ) {
        self.store = store
        self.action = action
        self.institutions = institutions
        self.account = account
        self.currencyLocked = currencyLocked
        self.mirrorCount = mirrorCount
        self.hasPortfolios = hasPortfolios
        self.hasTrades = hasTrades
        _name = State(initialValue: account?.name ?? "")
        _institutionId = State(initialValue: account?.institution?.id ?? defaultInstitutionId)
        _type = State(initialValue: account?.type ?? "current")
        _currency = State(initialValue: account?.currency ?? defaultCurrency)
        _iban = State(initialValue: account?.iban ?? "")
        _contractNumber = State(initialValue: account?.contractNumber ?? "")
        _depositIban = State(initialValue: account?.depositIban ?? "")
        _websiteUrl = State(initialValue: account?.websiteUrl ?? "")
        var opening = ""
        if let account, account.openingBalance != 0 {
            opening = Formats.amountInput(account.openingBalance, account.currency)
        }
        _openingBalance = State(initialValue: opening)
        _openingDate = State(initialValue: account?.openingDate ?? "")
        _share = State(initialValue: account == nil ? "100" : AccountsLogic.shareInput(account?.shareBps ?? 10_000))
        _sharedWith = State(initialValue: account?.sharedWith ?? "")
        var notice = ""
        if let months = account?.noticeMonths { notice = String(months) }
        _noticeMonths = State(initialValue: notice)
        var free = ""
        if let account, let amount = account.freeWithdrawal {
            free = Formats.amountInput(amount, account.currency)
        }
        _freeWithdrawal = State(initialValue: free)
        _period = State(initialValue: account?.freeWithdrawalPeriod ?? "")
        _fill = State(initialValue: account?.fillFromTransfers ?? false)
        _tradesCash = State(initialValue: account?.tradesMoveCash ?? false)
    }

    private var is3a: Bool { type == "pillar_3a" }
    private var hasNotice: Bool { AccountsLogic.hasNotice(type) }
    private var showFill: Bool { !is3a && !hasPortfolios }
    private var showTradesCash: Bool { type == "investment" || hasTrades }
    private var fillOn: Bool { showFill && fill }
    private var turningOff: Bool {
        guard let account else { return false }
        return account.fillFromTransfers && !fillOn && mirrorCount != 0
    }

    var body: some View {
        FormSheet(
            account == nil ? "Add account" : "Edit account",
            busy: store.busy,
            error: store.formErrors["form"],
            submitLabel: account == nil ? "Add" : "Save",
            submitDisabled: name.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            await save()
        } content: {
            identitySection
            if !is3a { topUpSection }
            moneySection
            if !is3a { shareSection }
            websiteSection
            if hasNotice { noticeSection }
            if showFill || showTradesCash { statementsSection }
        }
        .confirmationDialog("Stop filling this account?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Delete mirrors and save", role: .destructive) {
                confirmedOff = true
                Task {
                    let saved = await submit()
                    if saved { dismiss() }
                }
            }
            Button("Keep filling", role: .cancel) {}
        } message: {
            Text("The transactions Kept created from transfers in your other accounts are deleted and the balance is recalculated. Imported and manual transactions stay.")
        }
    }

    @ViewBuilder
    private var identitySection: some View {
        Section {
            TextField("Name", text: $name)
            FieldError(store.formErrors["name"])
            Picker("Institution", selection: $institutionId) {
                Text("None").tag("")
                ForEach(institutions) { institution in
                    Text(institution.name).tag(institution.id)
                }
            }
            FieldError(store.formErrors["institutionId"])
            Picker("Type", selection: $type) {
                ForEach(AccountsLogic.accountTypes, id: \.value) { entry in
                    Text(entry.label).tag(entry.value)
                }
            }
            FieldError(store.formErrors["type"])
            TextField("Currency (3 letters)", text: $currency)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .disabled(currencyLocked)
            FieldError(store.formErrors["currency"])
            TextField("IBAN (optional)", text: $iban)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["iban"])
        } footer: {
            if currencyLocked {
                Text("The currency is locked: this account already has transactions, balances, trades, portfolio values or an opening balance.")
            } else if is3a {
                Text("Pillar 3a accounts are held in CHF.")
            }
        }
    }

    @ViewBuilder
    private var topUpSection: some View {
        Section {
            TextField("Top-up IBAN (optional)", text: $depositIban)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            FieldError(store.formErrors["depositIban"])
        } footer: {
            Text("For an account without an IBAN of its own: the IBAN you send money to when you top it up. It is not this account's IBAN. Transfers to it from your other accounts are matched to this account.")
        }
    }

    @ViewBuilder
    private var moneySection: some View {
        Section {
            if is3a {
                TextField("Contract number (optional)", text: $contractNumber)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["contractNumber"])
                TextField("Deposit IBAN (QR-IBAN)", text: $depositIban)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["depositIban"])
            }
            AmountField("Opening balance", text: $openingBalance, currency: currency.uppercased())
            FieldError(store.formErrors["openingBalance"])
            DateField("Opening date", value: $openingDate, optional: true)
            FieldError(store.formErrors["openingDate"])
        } footer: {
            Text("Negative for debt, e.g. -120.50. The balance applies from the opening date.")
        }
    }

    @ViewBuilder
    private var shareSection: some View {
        Section {
            HStack {
                TextField("My share", text: $share)
                    .keyboardType(.numbersAndPunctuation)
                Text("%").foregroundStyle(.secondary)
            }
            FieldError(store.formErrors["share"])
            TextField("Shared with (optional)", text: $sharedWith)
            FieldError(store.formErrors["sharedWith"])
        } footer: {
            Text("Your ownership share if you co-own this account, e.g. 50 or 33.33. Leave at 100 otherwise.")
        }
    }

    @ViewBuilder
    private var websiteSection: some View {
        Section {
            TextField("Website (optional)", text: $websiteUrl)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            FieldError(store.formErrors["websiteUrl"])
        } footer: {
            Text("Link to the account's portal; the institution's link is used when empty.")
        }
    }

    @ViewBuilder
    private var noticeSection: some View {
        Section {
            TextField("Notice period in months (optional)", text: $noticeMonths)
                .keyboardType(.numberPad)
            FieldError(store.formErrors["noticeMonths"])
            AmountField("Free withdrawal", text: $freeWithdrawal, currency: currency.uppercased())
            FieldError(store.formErrors["freeWithdrawal"])
            Picker("Free withdrawal per", selection: $period) {
                Text("None").tag("")
                Text("Month").tag("month")
                Text("Year").tag("year")
            }
            FieldError(store.formErrors["freeWithdrawalPeriod"])
        } header: {
            Text("Withdrawal")
        } footer: {
            Text("The amount you can withdraw per month or year without notice. The rest is available once the notice period has passed.")
        }
    }

    @ViewBuilder
    private var statementsSection: some View {
        Section("Statements") {
            if showFill {
                Toggle("Fill from transfers in my other accounts", isOn: $fill)
                FieldError(store.formErrors["fillFromTransfers"])
            }
            if showTradesCash {
                Toggle("Trades move cash", isOn: $tradesCash)
                FieldError(store.formErrors["tradesMoveCash"])
            }
        }
    }

    private func save() async -> Bool {
        if turningOff && !confirmedOff {
            confirmOff = true
            return false
        }
        return await submit()
    }

    private func submit() async -> Bool {
        var form = FormFields()
        form.set("name", name)
        form.set("institutionId", institutionId)
        form.set("type", type)
        form.set("currency", currency.uppercased())
        form.set("iban", iban)
        form.set("openingBalance", openingBalance)
        form.set("openingDate", openingDate)
        if is3a {
            form.set("contractNumber", contractNumber)
        } else {
            form.set("share", share)
            form.set("sharedWith", sharedWith)
        }
        AccountsLogic.setIbanAndLinkFields(&form, is3a: is3a, depositIban: depositIban, websiteUrl: websiteUrl)
        if hasNotice {
            form.set("noticeMonths", noticeMonths)
            form.set("freeWithdrawal", freeWithdrawal)
            form.set("freeWithdrawalPeriod", period)
        }
        form.set("fillFromTransfersField", "1")
        form.check("fillFromTransfers", fillOn)
        form.check("tradesMoveCash", showTradesCash && tradesCash)
        if turningOff && confirmedOff { form.set("confirmRemoveMirrors", "1") }
        let result = await store.submit(action, form: form)
        confirmedOff = false
        return result != nil
    }
}
