import Foundation
@testable import Kept
import XCTest

final class RecurringContractTests: XCTestCase {
    func testRecurring() throws {
        let page = try ContractTests.decode(RecurringPage.self, "recurring")
        XCTAssertFalse(page.series.isEmpty)
        XCTAssertEqual(page.totals.first?.currency, "CHF")
        XCTAssertFalse(RecurringLogic.series(page.series, status: "suggested").isEmpty)
        XCTAssertFalse(RecurringLogic.series(page.series, status: "confirmed").isEmpty)
        XCTAssertFalse(RecurringLogic.series(page.series, status: "dismissed").isEmpty)
        XCTAssertTrue(page.series.contains { $0.priceChange != nil })
        XCTAssertTrue(page.series.contains { $0.priceChange == nil })
        XCTAssertTrue(page.series.contains { $0.counterpartyIban == nil })
        XCTAssertTrue(page.series.contains { $0.overdue })
        XCTAssertTrue(page.series.contains { $0.amount > 0 })
    }

    func testLogic() {
        XCTAssertEqual(RecurringLogic.cadenceLabel("quarterly"), "Quarterly")
        XCTAssertEqual(RecurringLogic.cadenceLabel("odd"), "odd")
        XCTAssertEqual(RecurringLogic.amountText(-1290, "CHF"), "12.90")
        XCTAssertEqual(RecurringLogic.amountText(950_000, "CHF"), "9500.00")
    }
}
