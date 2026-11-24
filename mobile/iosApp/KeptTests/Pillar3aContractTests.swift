import Foundation
@testable import Kept
import XCTest

final class Pillar3aContractTests: XCTestCase {
    private func value(_ form: FormFields, _ name: String) -> String? {
        form.fields.first { $0.name == name }?.value
    }

    func testPillar3a() throws {
        let page = try ContractTests.decode(Pillar3aPage.self, "pillar-3a")
        XCTAssertEqual(page.thisYear, 2026)
        XCTAssertFalse(page.overview.years.isEmpty)
        XCTAssertTrue(page.overview.years.contains { $0.earnedIncome != nil })
        XCTAssertTrue(page.overview.years.contains { $0.earnedIncome == nil })
        XCTAssertTrue(page.overview.years.contains { $0.closedBy != nil })
        XCTAssertFalse(page.overview.gaps.isEmpty)
        XCTAssertTrue(page.overview.portfolios.contains { $0.closedOn != nil })
        XCTAssertTrue(page.overview.portfolios.contains { $0.strategy == nil })
        XCTAssertFalse(page.overview.orphanAnnotations.isEmpty)
        XCTAssertTrue(page.contributions.contains { $0.source == "manual" && $0.id != nil && $0.transactionId == nil })
        XCTAssertTrue(page.contributions.contains { $0.source == "detected" && $0.id == nil })
        XCTAssertTrue(page.contributions.contains { $0.kind == "buy_in" && !$0.gapYears.isEmpty })
        XCTAssertTrue(page.contributions.contains { $0.lateDecemberWarning != nil })
        XCTAssertEqual(page.accounts.count, 1)
        XCTAssertTrue(page.overview.portfolios.contains { $0.reportedGain != nil && $0.returnBps != nil })
        XCTAssertTrue(page.overview.portfolios.contains { $0.reportedGain == nil && $0.returnBps == nil })
        let performance = try XCTUnwrap(page.performance)
        XCTAssertEqual(performance.count, 1)
        XCTAssertEqual(performance.first?.points.count, 2)
        XCTAssertEqual(performance.first?.points.last?.gainBps, 1244)
        XCTAssertEqual(performance.first?.points.last?.gain, 96_000)
    }

    func testLatestReturns() throws {
        let page = try ContractTests.decode(Pillar3aPage.self, "pillar-3a")
        let latest = Pillar3aText.latestReturns(page)
        XCTAssertEqual(latest.count, 1)
        let item = try XCTUnwrap(latest.first)
        XCTAssertEqual(item.name, "Example Portfolio A")
        XCTAssertEqual(item.basisPoints, 1244)
        XCTAssertEqual(item.gain, 96_000)
        XCTAssertEqual(item.date, "2026-11-18")
    }

    func testPerformanceIsOptional() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: ContractTests.fixture("pillar-3a")) as? [String: Any])
        object["performance"] = nil
        let data = try JSONSerialization.data(withJSONObject: object)
        let page = try JSONDecoder().decode(Pillar3aPage.self, from: data)
        XCTAssertNil(page.performance)
        XCTAssertTrue(Pillar3aText.latestReturns(page).isEmpty)
    }

    func testBuyInCheckDecodes() throws {
        let json = "{\"errors\":[\"Too much.\"],\"warnings\":[]}"
        let check = try JSONDecoder().decode(Pillar3aBuyInCheck.self, from: Data(json.utf8))
        XCTAssertEqual(check.errors, ["Too much."])
        XCTAssertTrue(check.warnings.isEmpty)
    }

    func testSavedDecodes() throws {
        let json = "{\"success\":true,\"action\":\"addContribution\",\"warnings\":[\"Pay the ordinary part.\"]}"
        let saved = try JSONDecoder().decode(Pillar3aSaved.self, from: Data(json.utf8))
        XCTAssertEqual(saved.warnings?.count, 1)
        let empty = try JSONDecoder().decode(Pillar3aSaved.self, from: Data("{}".utf8))
        XCTAssertNil(empty.warnings)
    }

    func testHelpers() {
        XCTAssertEqual(Pillar3aText.yearsText([2026, 2025]), "2025, 2026")
        XCTAssertEqual(Pillar3aText.yearsText([2026, 2025], separator: ","), "2025,2026")
        XCTAssertEqual(Pillar3aText.yearsText([]), "")
        XCTAssertEqual(Pillar3aText.fraction(ordinary: 50, limit: 100), 0.5)
        XCTAssertEqual(Pillar3aText.fraction(ordinary: 150, limit: 100), 1)
        XCTAssertEqual(Pillar3aText.fraction(ordinary: 10, limit: 0), 0)
        XCTAssertEqual(Pillar3aText.deductionLabel("none"), "No deduction")
        XCTAssertTrue(Pillar3aText.limitHint(deduction: "large", earnedIncome: nil).contains("income"))
        XCTAssertTrue(Pillar3aText.limitHint(deduction: "small", earnedIncome: nil).contains("Estimate"))
    }

    func testCheckQuery() {
        let query = Pillar3aText.checkQuery(date: "2026-01-20", amount: "1500.00", gapYears: [2026, 2025], key: "tx:1")
        XCTAssertEqual(query["gapYears"], "2025,2026")
        XCTAssertEqual(query["key"], "tx:1")
        XCTAssertEqual(query["amount"], "1500.00")
        XCTAssertNil(Pillar3aText.checkQuery(date: "d", amount: "", gapYears: [], key: nil)["key"])
    }

    func testContributionForms() {
        let manual = Pillar3aText.contributionForm(
            contribution: nil,
            portfolioId: "p1",
            amount: " 100.50 ",
            date: "2026-02-01",
            kind: "ordinary",
            gapYears: [2025],
            note: ""
        )
        XCTAssertEqual(value(manual, "portfolioId"), "p1")
        XCTAssertEqual(value(manual, "amount"), "100.50")
        XCTAssertEqual(value(manual, "gapYears"), "")
        XCTAssertNil(value(manual, "contributionId"))

        let buyIn = Pillar3aText.contributionForm(
            contribution: nil,
            portfolioId: "p1",
            amount: "10",
            date: "2026-02-01",
            kind: "buy_in",
            gapYears: [2025],
            note: "x"
        )
        XCTAssertEqual(value(buyIn, "gapYears"), "2025")
        XCTAssertEqual(value(buyIn, "note"), "x")
    }

    func testDetectedAndManualEditForms() throws {
        let page = try ContractTests.decode(Pillar3aPage.self, "pillar-3a")
        let detected = try XCTUnwrap(page.contributions.first { $0.source == "detected" })
        let manual = try XCTUnwrap(page.contributions.first { $0.source == "manual" })

        let detectedForm = Pillar3aText.contributionForm(
            contribution: detected,
            portfolioId: detected.portfolioId,
            amount: "1.00",
            date: "2026-01-20",
            kind: "ordinary",
            gapYears: [],
            note: ""
        )
        XCTAssertEqual(value(detectedForm, "transactionId"), detected.transactionId)
        XCTAssertNil(value(detectedForm, "amount"))
        XCTAssertNil(value(detectedForm, "portfolioId"))

        let manualForm = Pillar3aText.contributionForm(
            contribution: manual,
            portfolioId: manual.portfolioId,
            amount: "5258.00",
            date: manual.date,
            kind: "ordinary",
            gapYears: [],
            note: ""
        )
        XCTAssertEqual(value(manualForm, "contributionId"), manual.id)
        XCTAssertEqual(value(manualForm, "amount"), "5258.00")
        XCTAssertNil(value(manualForm, "transactionId"))

        XCTAssertEqual(value(Pillar3aText.deleteForm(detected), "transactionId"), detected.transactionId)
        XCTAssertEqual(value(Pillar3aText.deleteForm(manual), "contributionId"), manual.id)
    }

    func testYearForm() {
        let large = Pillar3aText.yearForm(year: 2026, deduction: "large", earnedIncome: " 90000.00 ")
        XCTAssertEqual(value(large, "year"), "2026")
        XCTAssertEqual(value(large, "earnedIncome"), "90000.00")
        let small = Pillar3aText.yearForm(year: 2026, deduction: "small", earnedIncome: "90000.00")
        XCTAssertNil(value(small, "earnedIncome"))
    }
}
