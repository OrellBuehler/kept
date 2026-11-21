import SwiftUI

/// `GET pages/settings/preferences`.
struct PreferencesPage: Decodable, Sendable {
    struct Values: Decodable, Sendable, Equatable {
        var ibanDisplay: String
        var blurAmounts: Bool
        var locale: String
        var defaultCurrency: String
        var pageSize: Int
        var investmentCashLiquid: Bool
    }

    let preferences: Values
}

struct PreferencesOption: Identifiable, Sendable {
    let value: String
    let label: String

    var id: String { value }
}

enum PreferencesLogic {
    static let ibanOptions: [PreferencesOption] = [
        PreferencesOption(value: "full", label: "Full"),
        PreferencesOption(value: "masked", label: "Masked"),
        PreferencesOption(value: "hidden", label: "Hidden"),
    ]

    static let locales: [PreferencesOption] = [
        PreferencesOption(value: "en-GB", label: "English (UK)"),
        PreferencesOption(value: "de-CH", label: "Deutsch (Schweiz)"),
        PreferencesOption(value: "de-DE", label: "Deutsch (Deutschland)"),
        PreferencesOption(value: "fr-CH", label: "Français (Suisse)"),
        PreferencesOption(value: "en-US", label: "English (US)"),
    ]

    static let currencies: [String] = ["CHF", "EUR", "USD", "GBP"]
    static let pageSizes: [Int] = [25, 50, 100, 200]

    nonisolated static func hint(_ ibanDisplay: String) -> String {
        switch ibanDisplay {
        case "masked": return "Show only the country code, check digits and last four characters."
        case "hidden": return "Never show IBANs."
        default: return "Show the whole IBAN."
        }
    }

    /// The fields of the `save` action: checkboxes are "on" or absent, like a browser sends them.
    nonisolated static func form(_ values: PreferencesPage.Values) -> FormFields {
        var form = FormFields()
        form.set("ibanDisplay", values.ibanDisplay)
        form.check("blurAmounts", values.blurAmounts)
        form.set("locale", values.locale)
        form.set("defaultCurrency", values.defaultCurrency)
        form.set("pageSize", String(values.pageSize))
        form.check("investmentCashLiquid", values.investmentCashLiquid)
        return form
    }

    /// An amount and a date in the chosen locale.
    nonisolated static func sample(_ locale: String) -> String {
        let formats = Formats(localeTag: locale)
        return formats.money(123_450, "CHF") + " · " + formats.date("2024-03-31")
    }
}

/// IBAN display, blurred amounts, number format, default currency, page size, liquid cash.
struct PreferencesView: View {
    @State private var store = PageStore<PreferencesPage>(path: "settings/preferences")

    var body: some View {
        PageView("Preferences", store: store) { page in
            PreferencesForm(page: page, store: store)
        }
    }
}

struct PreferencesForm: View {
    let page: PreferencesPage
    let store: PageStore<PreferencesPage>

    @State private var draft: PreferencesPage.Values
    @Environment(AppModel.self) private var model

    init(page: PreferencesPage, store: PageStore<PreferencesPage>) {
        self.page = page
        self.store = store
        _draft = State(initialValue: page.preferences)
    }

    private var changed: Bool {
        draft != page.preferences
    }

    var body: some View {
        Form {
            privacySection()
            displaySection()
            liquiditySection()
            if let message = store.formErrors["form"] {
                Section { Text(message).foregroundStyle(KeptColor.negative) }
            }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if store.busy {
                    ProgressView()
                } else {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(!changed)
                }
            }
        }
    }

    @ViewBuilder
    private func privacySection() -> some View {
        Section {
            Picker("IBAN display", selection: $draft.ibanDisplay) {
                ForEach(PreferencesLogic.ibanOptions) { option in
                    Text(option.label).tag(option.value)
                }
            }
            FieldError(store.formErrors["ibanDisplay"])
            Toggle("Blur amounts", isOn: $draft.blurAmounts)
        } header: {
            Text("Privacy")
        } footer: {
            Text(PreferencesLogic.hint(draft.ibanDisplay) + " Masked and hidden only change what is displayed on screen; your stored data and imports are not affected. Blurred amounts are shown as dots.")
        }
    }

    @ViewBuilder
    private func displaySection() -> some View {
        Section {
            Picker("Number and date format", selection: $draft.locale) {
                ForEach(PreferencesLogic.locales) { option in
                    Text(option.label).tag(option.value)
                }
            }
            FieldError(store.formErrors["locale"])
            Picker("Default currency", selection: $draft.defaultCurrency) {
                ForEach(PreferencesLogic.currencies, id: \.self) { code in
                    Text(code).tag(code)
                }
            }
            FieldError(store.formErrors["defaultCurrency"])
            Picker("Transactions per page", selection: $draft.pageSize) {
                ForEach(PreferencesLogic.pageSizes, id: \.self) { size in
                    Text("\(size)").tag(size)
                }
            }
            FieldError(store.formErrors["pageSize"])
        } header: {
            Text("Display")
        } footer: {
            Text("Example: " + PreferencesLogic.sample(draft.locale) + ". The default currency is pre-filled when you add an account, bill or budget.")
        }
    }

    @ViewBuilder
    private func liquiditySection() -> some View {
        Section {
            Toggle("Count cash in investment accounts as liquid", isOn: $draft.investmentCashLiquid)
        } header: {
            Text("Liquidity")
        } footer: {
            Text("Securities never count as liquid cash. Pension and pillar 3a accounts are always left out.")
        }
    }

    private func save() async {
        let result = await store.submit("save", form: PreferencesLogic.form(draft))
        if result != nil {
            await model.refreshSession()
        }
    }
}
