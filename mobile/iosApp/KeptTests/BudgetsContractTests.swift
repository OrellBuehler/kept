import Foundation
@testable import Kept
import XCTest

final class BudgetsContractTests: XCTestCase {
    func testBudgets() throws {
        let page = try ContractTests.decode(BudgetsPage.self, "budgets")
        XCTAssertEqual(page.month, "2026-10")
        XCTAssertTrue(page.hasShared)
        XCTAssertEqual(page.basis, "share")
        let report = try XCTUnwrap(page.report.currencies.first)
        XCTAssertEqual(report.currency, "CHF")
        XCTAssertFalse(report.rows.isEmpty)
        XCTAssertFalse(report.unbudgeted.isEmpty)
        XCTAssertTrue(report.rows.contains { $0.over })
        XCTAssertTrue(report.rows.contains { $0.parentName == nil })
        XCTAssertTrue(page.categories.contains { $0.kind == "income" })
        XCTAssertEqual(page.currencies, ["CHF", "EUR"])
    }

    func testCategoryLabel() throws {
        let page = try ContractTests.decode(BudgetsPage.self, "budgets")
        let groceries = try XCTUnwrap(page.categories.first { $0.name == "Groceries" })
        XCTAssertEqual(BudgetsLogic.categoryLabel(groceries, in: page.categories), "Food / Groceries")
        let housing = try XCTUnwrap(page.categories.first { $0.name == "Housing" })
        XCTAssertEqual(BudgetsLogic.categoryLabel(housing, in: page.categories), "Housing")
    }

    func testFractionAndName() {
        XCTAssertEqual(BudgetsLogic.fraction(spent: 50, budget: 200), 0.25, accuracy: 0.0001)
        XCTAssertEqual(BudgetsLogic.fraction(spent: 50, budget: 0), 0)
        XCTAssertEqual(BudgetsLogic.rowName(category: "Groceries", parent: "Food"), "Food / Groceries")
        XCTAssertEqual(BudgetsLogic.rowName(category: "Housing", parent: nil), "Housing")
    }
}
