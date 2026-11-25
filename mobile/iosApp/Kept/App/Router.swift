import Observation
import SwiftUI
import UIKit

enum AppTab: Hashable {
    case overview, accounts, bills, budgets, more
}

/// Every screen that is pushed onto a tab's stack. Mirrors the web's paths, so a redirect the
/// server answers with can be followed (`Route(webPath:)`).
enum Route: Hashable {
    case account(String)
    case accountImports(String)
    case bill(String)
    case billNew
    case forecast
    case recurring
    case review
    case reports
    case investments
    case pillar3a
    case taxes
    case taxYear(String)
    case importFiles
    case importPending(String)
    case importMapping(String)
    case settings
    case settingsCategories
    case settingsPreferences
    case settingsNotifications
    case settingsAccount
    case settingsMarketData

    /// The route for a web path such as "/bills/abc?x=1", or nil when the app has no screen for
    /// it (or it is one of the tabs).
    init?(webPath: String) {
        let path = webPath.split(separator: "?").first.map(String.init) ?? ""
        let parts = path.split(separator: "/").map(String.init)
        switch parts.count {
        case 1:
            switch parts[0] {
            case "forecast": self = .forecast
            case "recurring": self = .recurring
            case "review": self = .review
            case "reports": self = .reports
            case "investments": self = .investments
            case "pillar-3a": self = .pillar3a
            case "taxes": self = .taxes
            case "import": self = .importFiles
            default: return nil
            }
        case 2:
            switch (parts[0], parts[1]) {
            case ("bills", "new"): self = .billNew
            case let ("bills", id): self = .bill(id)
            case let ("accounts", id): self = .account(id)
            case let ("taxes", year): self = .taxYear(year)
            case let ("import", id): self = .importPending(id)
            case ("settings", "categories"): self = .settingsCategories
            case ("settings", "preferences"): self = .settingsPreferences
            case ("settings", "notifications"): self = .settingsNotifications
            case ("settings", "account"): self = .settingsAccount
            case ("settings", "market-data"): self = .settingsMarketData
            default: return nil
            }
        case 3:
            switch (parts[0], parts[2]) {
            case ("accounts", "imports"): self = .accountImports(parts[1])
            case ("import", "mapping"): self = .importMapping(parts[1])
            default: return nil
            }
        default:
            return nil
        }
    }
}

/// Navigation state: the selected tab and one stack per tab. Screens get it from the environment
/// (`@Environment(Router.self) private var router`) and call `push`, `pop` or `follow`.
@MainActor
@Observable
final class Router {
    var tab: AppTab = .overview
    var paths: [AppTab: [Route]] = [:]

    func path(for tab: AppTab) -> Binding<[Route]> {
        Binding(
            get: { self.paths[tab] ?? [] },
            set: { self.paths[tab] = $0 }
        )
    }

    func push(_ route: Route) {
        paths[tab, default: []].append(route)
    }

    func pop() {
        if paths[tab]?.isEmpty == false { paths[tab]?.removeLast() }
    }

    /// Replaces the screen on top: after a form created something, or a page redirected.
    func replaceTop(with route: Route) {
        if paths[tab]?.isEmpty == false { paths[tab]?.removeLast() }
        paths[tab, default: []].append(route)
    }

    /// Opens a bill from anywhere (a reminder was tapped).
    func openBill(_ id: String) {
        tab = .bills
        paths[.bills] = [.bill(id)]
    }

    /// Follows a web path from a redirect. Tabs are selected, known pages pushed (or put in place
    /// of the current one with `replacing`), anything else opens in the browser.
    func follow(webPath: String, replacing: Bool = false) {
        let path = webPath.split(separator: "?").first.map(String.init) ?? ""
        switch path {
        case "", "/":
            select(.overview, replacing: replacing)
        case "/accounts":
            select(.accounts, replacing: replacing)
        case "/bills":
            select(.bills, replacing: replacing)
        case "/budgets":
            select(.budgets, replacing: replacing)
        default:
            if let route = Route(webPath: webPath) {
                if replacing { replaceTop(with: route) } else { push(route) }
            } else {
                openInBrowser(webPath)
            }
        }
    }

    #if DEBUG
        /// Opens a web path as the only screen on the stack of the tab it belongs to (store screenshots).
        func open(webPath: String) {
            guard let route = Route(webPath: webPath) else {
                follow(webPath: webPath)
                return
            }
            switch route {
            case .account, .accountImports: tab = .accounts
            case .bill, .billNew: tab = .bills
            default: tab = .more
            }
            paths[tab] = [route]
        }
    #endif

    private func select(_ target: AppTab, replacing: Bool) {
        if replacing { pop() }
        if tab != target {
            tab = target
        }
    }

    /// Opens a page of the Kept server in the browser, for what the app does not do itself.
    func openInBrowser(_ webPath: String) {
        guard let base = SDKClient.shared.serverURL else { return }
        let trimmed = webPath.hasPrefix("/") ? String(webPath.dropFirst()) : webPath
        let full = (base.hasSuffix("/") ? base : base + "/") + trimmed
        if let url = URL(string: full) { UIApplication.shared.open(url) }
    }
}
