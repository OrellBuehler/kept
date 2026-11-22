import Foundation
@testable import Kept
import XCTest

final class ReportsContractTests: XCTestCase {
    func testReports() throws {
        let page = try ContractTests.decode(ReportsPage.self, "reports")
        XCTAssertNotNil(page.today.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression))
        XCTAssertTrue(page.hasShared)
        XCTAssertEqual(page.accounts.count, 10)
        XCTAssertTrue(page.accounts.contains { $0.iban == nil })
        XCTAssertTrue(page.accounts.contains { $0.archived })
        XCTAssertEqual(ReportsLogic.visible(page.accounts, showArchived: false).count, 9)
        XCTAssertEqual(ReportsLogic.visible(page.accounts, showArchived: true).count, 10)
    }

    func testLabels() throws {
        let page = try ContractTests.decode(ReportsPage.self, "reports")
        let archived = try XCTUnwrap(page.accounts.first { $0.archived })
        XCTAssertTrue(ReportsLogic.accountLabel(archived).hasSuffix("(CHF) · archived"))
        let open = try XCTUnwrap(page.accounts.first { !$0.archived })
        XCTAssertTrue(ReportsLogic.accountLabel(open).hasSuffix("(\(open.currency))"))
    }

    func testPeriod() {
        let november = ReportsLogic.lastFullMonth(today: "2026-11-21")
        XCTAssertEqual(november.from, "2026-10-01")
        XCTAssertEqual(november.to, "2026-10-31")
        let january = ReportsLogic.lastFullMonth(today: "2026-01-05")
        XCTAssertEqual(january.from, "2025-12-01")
        XCTAssertEqual(january.to, "2025-12-31")
        let march = ReportsLogic.lastFullMonth(today: "2024-03-10")
        XCTAssertEqual(march.to, "2024-02-29")
        XCTAssertEqual(ReportsLogic.daysInMonth(year: 2026, month: 2), 28)
        XCTAssertEqual(ReportsLogic.daysInMonth(year: 2100, month: 2), 28)
        XCTAssertEqual(ReportsLogic.daysInMonth(year: 2000, month: 2), 29)
        XCTAssertEqual(ReportsLogic.daysInMonth(year: 2026, month: 4), 30)
    }

    func testStatementValidity() {
        XCTAssertTrue(ReportsLogic.canDownloadStatement(accountId: "a", from: "2026-10-01", to: "2026-10-31"))
        XCTAssertTrue(ReportsLogic.canDownloadStatement(accountId: "a", from: "2026-10-01", to: "2026-10-01"))
        XCTAssertFalse(ReportsLogic.canDownloadStatement(accountId: "a", from: "2026-11-01", to: "2026-10-31"))
        XCTAssertFalse(ReportsLogic.canDownloadStatement(accountId: "", from: "2026-10-01", to: "2026-10-31"))
        XCTAssertFalse(ReportsLogic.canDownloadStatement(accountId: "a", from: "", to: "2026-10-31"))
    }

    func testYearsAndFileName() {
        XCTAssertEqual(ReportsLogic.taxYears(today: "2026-11-21").first, 2026)
        XCTAssertEqual(ReportsLogic.taxYears(today: "2026-11-21").count, 8)
        XCTAssertEqual(ReportsLogic.safeFileName("kept-bills-2026-11-21.pdf", kind: "bills"), "kept-bills-2026-11-21.pdf")
        XCTAssertEqual(ReportsLogic.safeFileName("../x/y.pdf", kind: "bills"), "kept-bills.pdf")
        XCTAssertEqual(ReportsLogic.safeFileName("a/b.pdf", kind: "bills"), "ab.pdf")
        XCTAssertEqual(ReportsLogic.safeFileName(nil, kind: "bills"), "kept-bills.pdf")
        XCTAssertEqual(ReportsLogic.safeFileName("..", kind: "bills"), "kept-bills.pdf")
    }
}
