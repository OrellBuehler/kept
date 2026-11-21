import SwiftUI

/// `GET pages/settings/market-data`.
struct MarketDataPage: Decodable, Sendable {
    struct Settings: Decodable, Sendable {
        let enabled: Bool
        let lastRunAt: Int64?
        let lastError: String?
    }

    let settings: Settings
    let providerAvailable: Bool
}

/// What `refresh` answers: how much was updated.
struct MarketDataRefreshAnswer: Decodable, Sendable {
    struct Counts: Decodable, Sendable {
        let securities: Int
        let fxPairs: Int
        let prices: Int
        let fxRates: Int
        let errors: [String]
    }

    let result: Counts
}

enum MarketDataLogic {
    nonisolated static func form(enabled: Bool) -> FormFields {
        var form = FormFields()
        form.check("enabled", enabled)
        return form
    }

    nonisolated static func summary(_ result: MarketDataRefreshAnswer.Counts) -> String {
        let securities = result.securities == 1 ? "1 security" : "\(result.securities) securities"
        let pairs = result.fxPairs == 1 ? "1 currency pair" : "\(result.fxPairs) currency pairs"
        var text = "Updated \(securities) and \(pairs) (\(result.prices) prices, \(result.fxRates) rates)."
        if !result.errors.isEmpty {
            let failed = result.errors.count == 1 ? "1 request" : "\(result.errors.count) requests"
            text += " \(failed) failed, see Last error."
        }
        return text
    }
}

/// Switch the price fetching on or off and refresh the prices now.
struct MarketDataView: View {
    @State private var store = PageStore<MarketDataPage>(path: "settings/market-data")

    var body: some View {
        PageView("Market data", store: store) { page in
            MarketDataForm(page: page, store: store)
        }
    }
}

struct MarketDataForm: View {
    let page: MarketDataPage
    let store: PageStore<MarketDataPage>

    @State private var enabled: Bool
    @Environment(\.formats) private var formats

    init(page: MarketDataPage, store: PageStore<MarketDataPage>) {
        self.page = page
        self.store = store
        _enabled = State(initialValue: page.settings.enabled)
    }

    private var lastRun: String {
        guard let at = page.settings.lastRunAt else { return "Never" }
        return ImportText.dateTime(at, locale: formats.locale)
    }

    var body: some View {
        Form {
            settingsSection()
            refreshSection()
        }
    }

    @ViewBuilder
    private func settingsSection() -> some View {
        Section {
            Toggle("Fetch prices from Yahoo Finance", isOn: $enabled)
            if !page.providerAvailable {
                Text("No market data provider is available in this installation.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            FieldError(store.formErrors["form"])
            Button {
                Task { await save() }
            } label: {
                if store.busy {
                    ProgressView()
                } else {
                    Text("Save")
                }
            }
            .disabled(store.busy || enabled == page.settings.enabled)
        } header: {
            Text("Market data")
        } footer: {
            Text("Kept can fetch daily closing prices for your securities and the exchange rates between their currency and your account's currency. It is off until you turn it on. Without it, you enter prices by hand.\n\nWhat leaves your server when this is on: the ticker symbols of your securities and currency pairs, with a date range; the text you type when you look up a security by ISIN or name; and your server's IP address, as with any web request. Quantities, amounts, trades, account names, transactions and balances are never sent. Prices are fetched about every six hours.")
        }
    }

    @ViewBuilder
    private func refreshSection() -> some View {
        Section {
            LabeledContent("Last run", value: lastRun)
            LabeledContent("Last error") {
                if let error = page.settings.lastError, !error.isEmpty {
                    Text(error).foregroundStyle(KeptColor.negative)
                } else {
                    Text("None")
                }
            }
            Button {
                Task { await refresh() }
            } label: {
                Label("Refresh now", systemImage: "arrow.clockwise")
            }
            .disabled(store.busy || !page.settings.enabled || !page.providerAvailable)
        } header: {
            Text("Refresh")
        } footer: {
            Text(page.settings.enabled ? "Fetch prices and rates now instead of waiting for the next scheduled run." : "Turn on market data above first.")
        }
    }

    private func save() async {
        let result = await store.submit("save", form: MarketDataLogic.form(enabled: enabled))
        if result != nil {
            store.message = "Market data settings saved."
        }
    }

    private func refresh() async {
        guard let result = await store.submit("refresh", showRefusal: true, reload: false) else { return }
        if let answer = try? result.decode(MarketDataRefreshAnswer.self) {
            store.message = MarketDataLogic.summary(answer.result)
        }
        await store.load()
    }
}
