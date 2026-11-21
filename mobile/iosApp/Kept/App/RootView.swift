import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.status {
        case nil:
            Color.clear
        case .noServer:
            ServerView()
        case let .signedOut(serverURL, expired):
            LoginView(serverURL: serverURL, expired: expired)
        case .signedIn:
            MainView()
        }
    }
}

/// The signed-in app: five tabs, everything else is pushed onto the tab's stack.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("Overview", systemImage: "square.grid.2x2", value: AppTab.overview) {
                stack(.overview) { DashboardView() }
            }
            Tab("Accounts", systemImage: "building.columns", value: AppTab.accounts) {
                stack(.accounts) { AccountsView() }
            }
            Tab("Bills", systemImage: "doc.text", value: AppTab.bills) {
                stack(.bills) { BillsView() }
            }
            .badge(model.session?.overdueBills ?? 0)
            Tab("Budgets", systemImage: "chart.pie", value: AppTab.budgets) {
                stack(.budgets) { BudgetsView() }
            }
            Tab("More", systemImage: "ellipsis", value: AppTab.more) {
                stack(.more) { MoreView() }
            }
        }
    }

    private func stack<Content: View>(_ tab: AppTab, @ViewBuilder root: () -> Content) -> some View {
        NavigationStack(path: router.path(for: tab)) {
            root()
                .navigationDestination(for: Route.self) { route in
                    destination(route)
                }
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case let .account(id): AccountView(id: id)
        case let .accountImports(id): AccountImportsView(id: id)
        case let .bill(id): BillView(id: id)
        case .billNew: BillNewView()
        case .forecast: ForecastView()
        case .recurring: RecurringView()
        case .review: ReviewView()
        case .reports: ReportsView()
        case .investments: InvestmentsView()
        case .pillar3a: Pillar3aView()
        case .taxes: TaxesView()
        case let .taxYear(year): TaxYearView(year: year)
        case .importFiles: ImportView()
        case let .importPending(id): ImportPendingView(pendingId: id)
        case let .importMapping(id): ImportMappingView(pendingId: id)
        case .settings: SettingsView()
        case .settingsCategories: CategoriesView()
        case .settingsPreferences: PreferencesView()
        case .settingsNotifications: NotificationsView()
        case .settingsAccount: AccountSettingsView()
        case .settingsMarketData: MarketDataView()
        }
    }
}
