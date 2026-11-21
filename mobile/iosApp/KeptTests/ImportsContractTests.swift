import Foundation
@testable import Kept
import XCTest

final class ImportsContractTests: XCTestCase {
    func testImportPage() throws {
        let page = try ContractTests.decode(ImportPage.self, "import")
        XCTAssertFalse(page.accounts.isEmpty)
        XCTAssertNotNil(page.accounts.first { $0.institution == nil })
        XCTAssertFalse(page.recentImports.isEmpty)
        XCTAssertTrue(page.recentImports.contains { !$0.warnings.isEmpty })
        XCTAssertTrue(page.inbox.enabled)
        XCTAssertNotNil(page.inbox.lastScan)
        XCTAssertTrue(page.inbox.entries.contains { $0.status == "review" })
        XCTAssertTrue(page.inbox.entries.contains { $0.status == "imported" && $0.newCount != nil })
        XCTAssertNotNil(page.selectedAccountId)
    }

    func testPendingPage() throws {
        let page = try ContractTests.decode(ImportPendingPage.self, "import.pendingId")
        XCTAssertEqual(page.account.currency, "CHF")
        XCTAssertEqual(page.format, "camt053")
        XCTAssertNotNil(page.statement?.openingBalance)
        XCTAssertFalse(page.rows.isEmpty)
        XCTAssertEqual(page.rows.first?.status, "duplicate")
        XCTAssertTrue(page.canConfirm)
        XCTAssertFalse(page.needsMapping)
        XCTAssertEqual(page.counts.total, 5)
    }

    func testPendingPageNeedingMapping() throws {
        let page = try ContractTests.decode(ImportPendingPage.self, "import.pendingId.needs-mapping")
        XCTAssertTrue(page.needsMapping)
        XCTAssertFalse(page.canConfirm)
        XCTAssertNil(page.statement)
        XCTAssertNil(page.account.iban)
        XCTAssertEqual(page.errors, ["mapping_required"])
        XCTAssertTrue(page.rows.isEmpty)
    }

    func testMappingPage() throws {
        let page = try ContractTests.decode(ImportMappingPage.self, "import.pendingId.mapping")
        XCTAssertEqual(page.format, "csv")
        XCTAssertFalse(page.detected.isEmpty)
        XCTAssertFalse(page.preview.isEmpty)
        XCTAssertNotNil(page.preview.first?.transaction)
        XCTAssertNotNil(page.profile)
        XCTAssertEqual(page.draft.columns?["description"]?.names, ["Description"])
        XCTAssertEqual(page.otherProfiles?.count, 1)
        XCTAssertFalse(page.saved)
        XCTAssertNil(page.savedName)
    }

    func testFormRoundTrip() throws {
        let page = try ContractTests.decode(ImportMappingPage.self, "import.pendingId.mapping")
        let form = ImportMappingForm(draft: page.draft)
        XCTAssertEqual(form.columns["bookingDate"], "Date")
        XCTAssertEqual(form.columns["amount"], "Amount")
        XCTAssertEqual(form.descriptionColumns, ["Description"])
        XCTAssertEqual(form.headerRowValue, 1)
        let data = Data(form.profileJSON().utf8)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["amountMode"] as? String, "single")
        XCTAssertEqual(object["headerRow"] as? Int, 1)
        XCTAssertEqual(object["defaultCurrency"] as? String, "CHF")
        let columns = try XCTUnwrap(object["columns"] as? [String: Any])
        XCTAssertEqual(columns["bookingDate"] as? String, "Date")
        XCTAssertEqual(columns["description"] as? [String], ["Description"])
        XCTAssertNil(object["indicatorCreditValues"])
    }

    func testFormDropsColumnsOfOtherAmountModes() throws {
        var form = ImportMappingForm()
        form.amountMode = "split"
        form.columns = ["bookingDate": "Date", "amount": "Amount", "credit": "In", "debit": "Out"]
        let object = form.profileObject()
        let columns = try XCTUnwrap(object["columns"] as? [String: Any])
        XCTAssertNil(columns["amount"])
        XCTAssertEqual(columns["credit"] as? String, "In")
        XCTAssertEqual(columns["debit"] as? String, "Out")
    }

    func testFormIndicatorValues() throws {
        var form = ImportMappingForm()
        form.amountMode = "single_with_indicator"
        form.creditValues = "CR; Credit , "
        let object = form.profileObject()
        XCTAssertEqual(object["indicatorCreditValues"] as? [String], ["CR", "Credit"])
        XCTAssertEqual(object["indicatorDebitValues"] as? [String], ["DBIT", "Debit", "DR", "D"])
    }

    func testPreviewBodyWrapsProfile() throws {
        let form = ImportMappingForm()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: form.previewBody()) as? [String: Any])
        XCTAssertNotNil(object["profile"] as? [String: Any])
    }

    func testLayoutValidation() {
        var form = ImportMappingForm()
        XCTAssertTrue(form.layoutValid)
        form.headerRow = "x"
        XCTAssertFalse(form.layoutValid)
        form.headerRow = "0"
        XCTAssertEqual(form.headerRowValue, 0)
        form.skipFooterRows = "-1"
        XCTAssertFalse(form.layoutValid)
    }

    func testColumnRefDecodesStringNumberAndList() throws {
        let json = Data(#"{"a":"Date","b":3,"c":["X",4]}"#.utf8)
        let map = try JSONDecoder().decode([String: ImportColumnRef].self, from: json)
        XCTAssertEqual(map["a"]?.names, ["Date"])
        XCTAssertEqual(map["b"]?.names, ["3"])
        XCTAssertEqual(map["c"]?.names, ["X", "4"])
    }

    func testTextHelpers() {
        XCTAssertEqual(ImportText.formatLabel("camt053"), "camt.053")
        XCTAssertEqual(ImportText.plural(1, "warning"), "1 warning")
        XCTAssertEqual(ImportText.plural(2, "warning"), "2 warnings")
        // Not an account number: the helper only groups and masks characters.
        let groups = ["ABCD", "EFGH", "IJKL", "MNOP", "QRST", "U"]
        let compact = groups.joined()
        XCTAssertEqual(ImportText.iban(compact, display: "full"), groups.joined(separator: " "))
        XCTAssertNil(ImportText.iban(compact, display: "hidden"))
        let dots = "\u{2022}\u{2022}\u{2022}\u{2022}"
        let masked = ["ABCD", dots, dots, dots, "\u{2022}RST", "U"]
        XCTAssertEqual(ImportText.iban(compact, display: "masked"), masked.joined(separator: " "))
        XCTAssertEqual(ImportText.contentType(forFileName: "A.CSV"), "text/csv")
        XCTAssertEqual(ImportText.bytes(512), "512 B")
    }
}
