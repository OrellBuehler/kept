import Foundation
@testable import Kept
import XCTest

final class InvestmentsContractTests: XCTestCase {
    func testInvestments() throws {
        let page = try ContractTests.decode(InvestmentsPage.self, "investments")
        XCTAssertEqual(page.overview.totals.first?.currency, "CHF")
        XCTAssertFalse(page.overview.securities.isEmpty)
        XCTAssertTrue(page.overview.securities.allSatisfy { !$0.positions.isEmpty })
        XCTAssertEqual(page.securities.count, 3)
        XCTAssertTrue(page.securities.contains { $0.symbol == nil })
        XCTAssertTrue(page.securities.contains { $0.isin == nil })
        XCTAssertFalse(page.marketData.canLookup)
        let history = try XCTUnwrap(page.priceHistory)
        XCTAssertEqual(history.prices.count, history.total)
        XCTAssertTrue(history.prices.contains { $0.source == "manual" })
        XCTAssertEqual(history.prices.first?.price, 5_840_000_000)
    }

    func testLookupResultDecodes() throws {
        let json = """
        {"success":true,"action":"lookup","matches":[
        {"symbol":"EXWLD","name":"Example World ETF","currency":"CHF","kind":"etf","isin":"EX0000000013"},
        {"symbol":"EXBND","name":"Example Bond","currency":null,"kind":null,"isin":null}]}
        """
        let result = try JSONDecoder().decode(InvestmentsLookupResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.matches.count, 2)
        XCTAssertEqual(result.matches[0].kind, "etf")
        XCTAssertNil(result.matches[1].currency)
    }

    func testFixedInput() {
        XCTAssertEqual(InvestmentsText.input(150_000_000), "1.5")
        XCTAssertEqual(InvestmentsText.input(1), "0.00000001")
        XCTAssertEqual(InvestmentsText.input(5_840_000_000), "58.4")
        XCTAssertEqual(InvestmentsText.input(200_000_000), "2")
        XCTAssertEqual(InvestmentsText.input(-250_000_000), "-2.5")
        XCTAssertEqual(InvestmentsText.input(0), "0")
    }

    func testFixedFormat() {
        let locale = Locale(identifier: "en-GB")
        XCTAssertEqual(InvestmentsText.format(150_000_000, locale: locale), "1.5")
        XCTAssertEqual(InvestmentsText.format(200_000_000, locale: locale, minFraction: 2), "2.00")
        XCTAssertEqual(InvestmentsText.format(123_456_000_000_000, locale: locale), "1,234,560")
        XCTAssertEqual(InvestmentsText.format(-1_234_500_000, locale: locale, minFraction: 2), "-12.345")
        XCTAssertEqual(InvestmentsText.format(1, locale: locale), "0.00000001")
    }

    func testLabels() {
        XCTAssertEqual(InvestmentsText.kindLabel("etf"), "ETF")
        XCTAssertEqual(InvestmentsText.kindLabel("new"), "new")
        XCTAssertEqual(InvestmentsText.sourceLabel("provider"), "fetched")
        XCTAssertEqual(InvestmentsText.sourceLabel("trade"), "last trade")
    }
}
