import Foundation
@testable import Kept
import XCTest

final class ForecastContractTests: XCTestCase {
    func testForecast() throws {
        let page = try ContractTests.decode(ForecastPage.self, "forecast")
        XCTAssertEqual(page.days, 60)
        XCTAssertEqual(page.horizons, [30, 60, 90])
        XCTAssertFalse(page.forecast.accounts.isEmpty)
        XCTAssertFalse(page.forecast.items.isEmpty)
        XCTAssertFalse(page.forecast.unassigned.isEmpty)
        XCTAssertTrue(page.forecast.accounts.contains { $0.warning != nil })
        XCTAssertTrue(page.forecast.accounts.contains { $0.warning == nil })
        XCTAssertTrue(page.forecast.accounts.contains { $0.negativeDate != nil })
        XCTAssertTrue(page.forecast.accounts.contains { !$0.hasBalance })
        XCTAssertTrue(page.forecast.accounts.contains { $0.threshold == nil })
        XCTAssertTrue(page.forecast.accounts.allSatisfy { $0.points.count >= 2 })
        XCTAssertTrue(page.planned.contains { $0.accountId == nil })
        XCTAssertFalse(page.settings.isEmpty)
        XCTAssertEqual(page.forecast.unprojectedBills.noDueDate, 0)
    }

    func testLogic() throws {
        let page = try ContractTests.decode(ForecastPage.self, "forecast")
        XCTAssertEqual(ForecastLogic.sourceLabel("bill"), "Bill")
        XCTAssertEqual(ForecastLogic.sourceLabel("other"), "other")
        XCTAssertEqual(ForecastLogic.direction(500), "income")
        XCTAssertEqual(ForecastLogic.direction(-500), "expense")
        XCTAssertEqual(ForecastLogic.amountText(-45_000, "CHF"), "450.00")
        XCTAssertEqual(ForecastLogic.accountName(nil, in: page.forecast.accounts), "No account")
        XCTAssertEqual(ForecastLogic.accountName("unknown", in: page.forecast.accounts), "Account")
        let first = try XCTUnwrap(page.forecast.accounts.first)
        XCTAssertEqual(ForecastLogic.accountName(first.accountId, in: page.forecast.accounts), first.name)
        XCTAssertFalse(ForecastLogic.warnings(page.forecast.accounts).isEmpty)
    }
}
