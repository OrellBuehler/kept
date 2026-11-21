import Foundation
@testable import Kept
import XCTest

final class SettingsPagesContractTests: XCTestCase {
    // MARK: Market data

    func testMarketDataPage() throws {
        let page = try ContractTests.decode(MarketDataPage.self, "settings.market-data")
        XCTAssertFalse(page.settings.enabled)
        XCTAssertNil(page.settings.lastRunAt)
        XCTAssertNil(page.settings.lastError)
        XCTAssertFalse(page.providerAvailable)
    }

    func testMarketDataRefresh() throws {
        let json = #"{"success":true,"action":"refresh","result":{"securities":1,"fxPairs":2,"prices":10,"fxRates":4,"errors":["x"]}}"#
        let answer = try JSONDecoder().decode(MarketDataRefreshAnswer.self, from: Data(json.utf8))
        XCTAssertEqual(
            MarketDataLogic.summary(answer.result),
            "Updated 1 security and 2 currency pairs (10 prices, 4 rates). 1 request failed, see Last error."
        )
        XCTAssertEqual(MarketDataLogic.form(enabled: true).fields.first?.value, "on")
        XCTAssertTrue(MarketDataLogic.form(enabled: false).fields.isEmpty)
    }

    // MARK: Account

    func testAccountSettingsPage() throws {
        let page = try ContractTests.decode(AccountSettingsPage.self, "settings.account")
        XCTAssertEqual(page.user.username, "alice")
        XCTAssertEqual(page.user.displayName, "Alice Example")
        XCTAssertEqual(page.user.role, "admin")
    }

    func testPasswordChecks() {
        XCTAssertNotNil(AccountSettingsLogic.problem(newPassword: "short", confirmation: "short"))
        XCTAssertEqual(
            AccountSettingsLogic.problem(newPassword: "long enough pass", confirmation: "other"),
            "Passwords do not match."
        )
        XCTAssertNil(AccountSettingsLogic.problem(newPassword: "long enough pass", confirmation: "long enough pass"))
        let form = AccountSettingsLogic.form(current: "a", new: "b")
        XCTAssertEqual(form.fields.map { $0.name }, ["currentPassword", "newPassword"])
    }

    // MARK: Notifications

    func testNotificationsPage() throws {
        let page = try ContractTests.decode(NotificationSettingsPage.self, "settings.notifications")
        XCTAssertTrue(page.settings.billDueEnabled)
        XCTAssertEqual(page.settings.budgetPercent, 90)
        XCTAssertFalse(page.settings.staleImportEnabled)
        XCTAssertEqual(page.channels.count, 2)
        let ntfy = try XCTUnwrap(page.channels.first { $0.kind == "ntfy" })
        XCTAssertTrue(ntfy.hasSecret)
        XCTAssertNil(ntfy.lastError)
        XCTAssertNotNil(ntfy.lastSuccessAt)
        XCTAssertEqual(ntfy.fields["topic"], "kept-example")
        let webhook = try XCTUnwrap(page.channels.first { $0.kind == "webhook" })
        XCTAssertEqual(webhook.lastError, "http_500")
        XCTAssertNil(webhook.lastSuccessAt)
        XCTAssertEqual(page.emailBlocked, "smtp")
        XCTAssertEqual(page.kinds, ["ntfy", "webhook"])
    }

    func testNotificationsLogic() throws {
        let page = try ContractTests.decode(NotificationSettingsPage.self, "settings.notifications")
        XCTAssertEqual(NotificationSettingsLogic.shownKinds(page), ["ntfy", "webhook"])
        XCTAssertNotNil(NotificationSettingsLogic.lockedMessage(page, kind: "email"))
        XCTAssertNil(NotificationSettingsLogic.lockedMessage(page, kind: "ntfy"))
        let ntfy = try XCTUnwrap(page.channels.first { $0.kind == "ntfy" })
        XCTAssertEqual(NotificationSettingsLogic.channelSummary(ntfy), "https://ntfy.example.org / kept-example")
    }

    func testNotificationsForms() {
        let triggers = NotificationSettingsLogic.triggerForm(
            billDueEnabled: true,
            billDueDays: " 5 ",
            billOverdueEnabled: false,
            budgetEnabled: true,
            budgetPercent: "90",
            staleImportEnabled: false,
            staleImportDays: "21"
        )
        let names = triggers.fields.map { $0.name }
        XCTAssertTrue(names.contains("billDueEnabled"))
        XCTAssertFalse(names.contains("billOverdueEnabled"))
        XCTAssertEqual(triggers.fields.first { $0.name == "billDueDays" }?.value, "5")

        let channel = NotificationSettingsLogic.channelForm(
            kind: "ntfy",
            serverUrl: "https://ntfy.example.org",
            topic: "kept-example",
            url: "",
            recipient: "",
            secret: "",
            removeSecret: false
        )
        XCTAssertEqual(channel.fields.first { $0.name == "token" }?.value, "")
        XCTAssertNil(channel.fields.first { $0.name == "removeSecret" })
        XCTAssertNil(channel.fields.first { $0.name == "url" })
    }

    func testNotificationsTestAnswer() throws {
        let ok = try JSONDecoder().decode(
            NotificationSettingsTestAnswer.self,
            from: Data(#"{"action":"test","kind":"ntfy","result":{"ok":true}}"#.utf8)
        )
        XCTAssertTrue(ok.result.ok)
        XCTAssertNil(ok.result.reason)
        let failed = try JSONDecoder().decode(
            NotificationSettingsTestAnswer.self,
            from: Data(#"{"result":{"ok":false,"reason":"http_500"}}"#.utf8)
        )
        XCTAssertEqual(failed.result.reason, "http_500")
    }

    // MARK: Preferences

    func testPreferencesPage() throws {
        let page = try ContractTests.decode(PreferencesPage.self, "settings.preferences")
        XCTAssertEqual(page.preferences.ibanDisplay, "masked")
        XCTAssertTrue(page.preferences.blurAmounts)
        XCTAssertEqual(page.preferences.locale, "de-CH")
        XCTAssertEqual(page.preferences.pageSize, 25)
        XCTAssertTrue(page.preferences.investmentCashLiquid)
    }

    func testPreferencesForm() throws {
        let page = try ContractTests.decode(PreferencesPage.self, "settings.preferences")
        var values = page.preferences
        values.investmentCashLiquid = false
        let form = PreferencesLogic.form(values)
        let names = form.fields.map { $0.name }
        XCTAssertTrue(names.contains("blurAmounts"))
        XCTAssertFalse(names.contains("investmentCashLiquid"))
        XCTAssertEqual(form.fields.first { $0.name == "pageSize" }?.value, "25")
        XCTAssertEqual(form.fields.first { $0.name == "blurAmounts" }?.value, "on")
        XCTAssertTrue(PreferencesLogic.currencies.contains(page.preferences.defaultCurrency))
        XCTAssertTrue(PreferencesLogic.pageSizes.contains(page.preferences.pageSize))
        XCTAssertTrue(PreferencesLogic.locales.contains { $0.value == page.preferences.locale })
    }

    // MARK: Categories

    func testCategoriesPage() throws {
        let page = try ContractTests.decode(CategoriesPage.self, "settings.categories")
        XCTAssertFalse(page.categories.isEmpty)
        XCTAssertFalse(page.rules.isEmpty)
        XCTAssertTrue(page.categories.contains { $0.color == nil })
        XCTAssertTrue(page.categories.contains { $0.icon == nil })
        XCTAssertTrue(page.categories.contains { $0.parentId != nil })
        XCTAssertTrue(page.categories.contains { $0.kind == "income" })
        XCTAssertTrue(page.rules.contains { $0.amountSign == nil })
        XCTAssertTrue(page.rules.contains { $0.counterpartyIban != nil })
    }

    func testCategoriesOrderPutsChildrenUnderTheirParent() throws {
        let page = try ContractTests.decode(CategoriesPage.self, "settings.categories")
        let ordered = CategoriesLogic.ordered(page.categories)
        XCTAssertEqual(ordered.count, page.categories.count)
        for (index, category) in ordered.enumerated() {
            guard let parentId = category.parentId else { continue }
            XCTAssertGreaterThan(index, 0)
            let before = ordered[0 ..< index]
            XCTAssertTrue(before.contains { $0.id == parentId })
        }
    }

    func testCategoriesLogic() throws {
        let page = try ContractTests.decode(CategoriesPage.self, "settings.categories")
        let groceries = try XCTUnwrap(page.categories.first { $0.name == "Groceries" })
        XCTAssertEqual(CategoriesLogic.label(groceries, in: page.categories), "Food / Groceries")
        XCTAssertEqual(CategoriesLogic.symbol("utensils"), "fork.knife")
        XCTAssertEqual(CategoriesLogic.symbol(nil), "tag")
        let rule = try XCTUnwrap(page.rules.first { $0.counterpartyContains == "Grocer" })
        XCTAssertEqual(CategoriesLogic.conditions(rule), "counterparty contains \"Grocer\" and money out")
        let applied = CategoriesApplyResult(categorized: 1, scanned: 1)
        XCTAssertEqual(CategoriesLogic.appliedMessage(applied), "Categorized 1 of 1 uncategorized transaction.")
    }
}
