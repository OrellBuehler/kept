import Foundation
@testable import Kept
import XCTest

final class TaxesContractTests: XCTestCase {
    private func value(_ form: FormFields, _ name: String) -> String? {
        form.fields.first { $0.name == name }?.value
    }

    func testTaxes() throws {
        let page = try ContractTests.decode(TaxesPage.self, "taxes")
        XCTAssertEqual(page.years.count, 1)
        XCTAssertEqual(page.years.first?.year, 2025)
        XCTAssertEqual(page.years.first?.currency, "CHF")
        XCTAssertEqual(page.years.first?.balance.outcome, "due")
        XCTAssertEqual(page.years.first?.discrepancies, 5)
        XCTAssertEqual(page.years.first?.reconciled, false)
        XCTAssertEqual(page.defaultYear, 2025)
        XCTAssertEqual(page.defaultCurrency, "CHF")
    }

    func testTaxYear() throws {
        let page = try ContractTests.decode(TaxYearPage.self, "taxes.year")
        let reconciliation = page.reconciliation
        XCTAssertEqual(reconciliation.year.year, 2025)
        XCTAssertNotNil(reconciliation.year.id)
        XCTAssertEqual(reconciliation.year.assessedTotal, 550_000)
        XCTAssertEqual(reconciliation.rows.count, 6)
        XCTAssertEqual(reconciliation.counts.amountMismatch, 1)
        XCTAssertEqual(reconciliation.counts.missingOffice, 2)
        XCTAssertEqual(reconciliation.counts.missingMine, 2)
        XCTAssertEqual(reconciliation.differences, 5)
        XCTAssertFalse(reconciliation.reconciled)
        XCTAssertEqual(reconciliation.balance.outcome, "due")
        XCTAssertEqual(reconciliation.balance.remainingByMe, -160_000)

        XCTAssertTrue(reconciliation.rows.contains { $0.kind == "missing_mine" && $0.mine == nil && $0.office != nil })
        XCTAssertTrue(reconciliation.rows.contains { $0.kind == "missing_office" && $0.office == nil && $0.mine != nil })
        XCTAssertTrue(reconciliation.rows.contains { $0.mine?.via == "bill" })
        XCTAssertTrue(reconciliation.rows.contains { $0.mine?.reference == nil && $0.mine != nil })
        XCTAssertTrue(reconciliation.rows.contains { $0.office?.description == nil && $0.office != nil })
        XCTAssertEqual(Set(reconciliation.rows.map { $0.id }).count, reconciliation.rows.count)

        XCTAssertEqual(reconciliation.suggestions.count, 1)
        let creditIds = Set(reconciliation.rows.compactMap { $0.office?.id })
        XCTAssertTrue(creditIds.contains(reconciliation.suggestions[0].creditId))
    }

    func testTaxYearDeductions() throws {
        let page = try ContractTests.decode(TaxYearPage.self, "taxes.year")
        XCTAssertEqual(page.deductionMoves, 0)
        XCTAssertEqual(page.deductions.year, 2025)
        XCTAssertEqual(page.deductions.totals.count, 3)
        XCTAssertTrue(page.deductions.totals.contains { $0.type == "pillar_3a" })
        let lines = page.deductions.totals.flatMap { $0.lines }
        XCTAssertTrue(lines.contains { $0.transactionId == nil })
        XCTAssertTrue(lines.contains { $0.explicitYear })
        XCTAssertEqual(page.deductions.excluded.count, 1)
        XCTAssertEqual(page.deductions.excluded.first?.type, "donations")
        XCTAssertTrue(page.deductionMappings.contains { $0.own != nil })
        XCTAssertTrue(page.deductionMappings.contains { $0.inherited && $0.effective != nil })
        XCTAssertTrue(page.deductionMappings.contains { $0.parentId != nil })
        let pillar = try XCTUnwrap(page.pillar3a)
        XCTAssertEqual(pillar.limit, 725_800)
        XCTAssertEqual(pillar.deductible, 575_800)
        XCTAssertFalse(pillar.limitUnconfirmed)
    }

    func testLabels() {
        XCTAssertEqual(TaxText.rowLabel("amount_mismatch"), "Amount differs")
        XCTAssertEqual(TaxText.rowLabel("matched"), "Matched")
        XCTAssertEqual(TaxText.deductionLabel("debt_interest"), "Debt interest")
        XCTAssertEqual(TaxText.deductionLabel("other"), "Other deductions")
        XCTAssertEqual(TaxText.differencesText(1), "1 difference")
        XCTAssertEqual(TaxText.differencesText(3), "3 differences")
        XCTAssertEqual(TaxText.deductionTypes.count, 9)
        XCTAssertEqual(TaxText.mappingNoneLabel(inherited: true, effective: "medical"), "Inherited: Medical and health costs")
        XCTAssertEqual(TaxText.mappingNoneLabel(inherited: false, effective: nil), "Not a deduction")
    }

    func testOutcome() throws {
        let page = try ContractTests.decode(TaxYearPage.self, "taxes.year")
        let due = page.reconciliation.balance
        XCTAssertEqual(TaxText.outcomeLabel(due), "Due")
        XCTAssertEqual(TaxText.outcomeAmount(due), 21_000)

        let json = """
        {"paidByMe":0,"creditedByOffice":0,"difference":0,"assessedTotal":null,"remaining":null,
        "remainingByMe":null,"outcome":"unknown","amountDue":0,"refundExpected":0}
        """
        let unknown = try JSONDecoder().decode(TaxBalance.self, from: Data(json.utf8))
        XCTAssertEqual(TaxText.outcomeLabel(unknown), "No assessment")
        XCTAssertNil(TaxText.outcomeAmount(unknown))
        XCTAssertNil(unknown.assessedTotal)
    }

    func testForms() {
        let details = TaxText.detailsForm(
            year: "2025",
            authority: " Example Tax Office ",
            currency: "CHF",
            assessedTotal: " 5500.00 ",
            notes: ""
        )
        XCTAssertEqual(value(details, "year"), "2025")
        XCTAssertEqual(value(details, "authority"), "Example Tax Office")
        XCTAssertEqual(value(details, "assessedTotal"), "5500.00")

        let credit = TaxText.creditForm(date: "2025-03-12", amount: " -50.00", reference: "", description: "Refund")
        XCTAssertEqual(value(credit, "bookingDate"), "2025-03-12")
        XCTAssertEqual(value(credit, "amount"), "-50.00")
        XCTAssertEqual(value(credit, "description"), "Refund")

        let mapping = TaxText.setDeductionForm(categoryId: "c1", type: "")
        XCTAssertEqual(value(mapping, "categoryId"), "c1")
        XCTAssertEqual(value(mapping, "deductionType"), "")
        XCTAssertEqual(value(TaxText.transactionForm("t1"), "transactionId"), "t1")
    }
}
