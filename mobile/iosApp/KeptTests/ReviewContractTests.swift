import Foundation
@testable import Kept
import XCTest

final class ReviewContractTests: XCTestCase {
    func testReview() throws {
        let page = try ContractTests.decode(ReviewPage.self, "review")
        XCTAssertEqual(page.year, 2026)
        XCTAssertEqual(page.firstYear, 2024)
        XCTAssertTrue(page.review.partial)
        XCTAssertGreaterThan(page.review.excludedTransfers, 0)
        XCTAssertEqual(page.review.currencies.count, 2)
        let chf = try XCTUnwrap(page.review.currencies.first { $0.currency == "CHF" })
        XCTAssertEqual(chf.months.count, 12)
        XCTAssertTrue(chf.hasPreviousYear)
        XCTAssertNotNil(chf.savingsRate)
        XCTAssertNotNil(chf.netWorth)
        XCTAssertFalse(chf.sankey.left.isEmpty)
        XCTAssertFalse(chf.sankey.right.isEmpty)
        XCTAssertNil(chf.sankey.total.color)
        XCTAssertTrue(chf.changes.contains { $0.changePct == nil })
        XCTAssertFalse(chf.counterparties.isEmpty)
        XCTAssertFalse(chf.largestIncome.isEmpty)
        let eur = try XCTUnwrap(page.review.currencies.first { $0.currency == "EUR" })
        XCTAssertFalse(eur.hasPreviousYear)
        XCTAssertTrue(eur.largestExpenses.contains { $0.counterparty == nil })
        XCTAssertTrue(eur.largestExpenses.contains { $0.categoryName == nil })
    }

    func testLogic() {
        XCTAssertEqual(ReviewLogic.years(first: 2024, current: 2026, selected: 2026), [2026, 2025, 2024])
        XCTAssertEqual(ReviewLogic.years(first: 2025, current: 2026, selected: 2023), [2026, 2025, 2024, 2023])
        XCTAssertEqual(ReviewLogic.share(50, of: 200), 0.25, accuracy: 0.0001)
        XCTAssertEqual(ReviewLogic.share(50, of: 0), 0)
        XCTAssertEqual(ReviewLogic.share(500, of: 200), 1)
        XCTAssertEqual(ReviewLogic.monthLabel("2026-01", locale: Locale(identifier: "en-GB")), "Jan")
    }

    func testChangeLabel() throws {
        let page = try ContractTests.decode(ReviewPage.self, "review")
        let chf = try XCTUnwrap(page.review.currencies.first)
        let change = try XCTUnwrap(chf.changes.first { $0.changePct == nil })
        XCTAssertEqual(ReviewLogic.changeLabel(change, formats: Formats()), "new")
    }
}
