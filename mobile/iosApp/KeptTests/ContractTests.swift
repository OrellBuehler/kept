import Foundation
@testable import Kept
import XCTest

/// The page fixtures in `src/lib/testing/fixtures/app-contract/` are what the server answers (it writes them and checks
/// its pages against them, see src/routes/api/app/v1/contract.test.ts). Every model the app
/// decodes a page into gets a test here that decodes the matching fixture.
final class ContractTests: XCTestCase {
    /// The `data` object of a page fixture ("bills", "accounts.id.checking", …), or the whole
    /// file for the fixtures that are not pages ("session", "server", "reminders").
    static func fixture(_ name: String) throws -> Data {
        let bundle = Bundle(for: ContractTests.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: name, withExtension: "json", subdirectory: "app-contract"),
            "missing fixture \(name).json"
        )
        let data = try Data(contentsOf: url)
        let object = try JSONSerialization.jsonObject(with: data)
        if let page = (object as? [String: Any])?["data"] {
            return try JSONSerialization.data(withJSONObject: page)
        }
        return data
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: fixture(name))
    }

    func testSession() throws {
        let session = try Self.decode(SessionDetails.self, "session")
        XCTAssertFalse(session.user.username.isEmpty)
        XCTAssertFalse(session.preferences.defaultCurrency.isEmpty)
    }

    func testDashboard() throws {
        let page = try Self.decode(DashboardPage.self, "dashboard")
        XCTAssertFalse(page.dashboard.netWorth.totals.isEmpty)
        XCTAssertGreaterThanOrEqual(page.dashboard.netWorth.series.first?.points.count ?? 0, 2)
        XCTAssertTrue(page.dashboard.accounts.contains { $0.institution != nil })
        XCTAssertFalse(page.dashboard.month.totals.isEmpty)
        XCTAssertFalse(page.dashboard.bills.upcoming.isEmpty)
        XCTAssertFalse(page.forecastAlerts.isEmpty)
        XCTAssertFalse(page.needsAmount.isEmpty)
        XCTAssertTrue(page.dashboard.accounts.contains { $0.lastImportAt != nil })
        XCTAssertTrue(page.dashboard.accounts.contains { $0.staleDays != nil })
        XCTAssertTrue(page.dashboard.accounts.contains { $0.staleDays == nil })
    }

    func testDashboardAccountChecked() throws {
        let json = """
        {"id": "a", "name": "Example Wallet", "type": "current", "currency": "CHF", "balance": 100, "shareBalance": 100,
         "stale": true, "staleDays": 50, "lastImportAt": 1795372853185, "lastCheckedAt": 1795900000000}
        """
        let account = try JSONDecoder().decode(Dashboard.Account.self, from: Data(json.utf8))
        XCTAssertEqual(account.staleDays, 50)
        XCTAssertEqual(account.lastImportAt, 1_795_372_853_185)
        XCTAssertEqual(account.lastCheckedAt, 1_795_900_000_000)
        XCTAssertNil(account.institution)
    }

    func testRoutesFollowWebPaths() {
        XCTAssertEqual(Route(webPath: "/bills/abc"), .bill("abc"))
        XCTAssertEqual(Route(webPath: "/bills/new"), .billNew)
        XCTAssertEqual(Route(webPath: "/import/p1/mapping?x=1"), .importMapping("p1"))
        XCTAssertEqual(Route(webPath: "/accounts/a1/imports"), .accountImports("a1"))
        XCTAssertNil(Route(webPath: "/settings/security"))
        XCTAssertNil(Route(webPath: "/bills"))
    }

    func testAmountInput() {
        XCTAssertEqual(Formats.amountInput(123_450, "CHF"), "1234.50")
        XCTAssertEqual(Formats.amountInput(-5, "EUR"), "-0.05")
        XCTAssertEqual(Formats.amountInput(500, "JPY"), "500")
    }
}
