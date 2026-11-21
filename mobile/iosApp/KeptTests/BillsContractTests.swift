import Foundation
@testable import Kept
import UIKit
import XCTest

final class BillsContractTests: XCTestCase {
    /// Not an account number: the text helpers only group and mask characters.
    private let plain = "ABCDEFGHIJKLMNOPQRSTU"
    private let plainGrouped = "ABCD EFGH IJKL MNOP QRST U"

    func testBillsPage() throws {
        let page = try ContractTests.decode(BillsPage.self, "bills")
        XCTAssertEqual(page.counts.total, 7)
        XCTAssertEqual(page.groups.overdue.count, 1)
        XCTAssertEqual(page.groups.dueSoon.count, 2)
        XCTAssertEqual(page.groups.awaitingRefund.count, 1)
        XCTAssertEqual(page.list.items.count, 7)
        XCTAssertEqual(page.query.status, "all")
        XCTAssertEqual(page.list.page, 1)
        XCTAssertFalse(page.suggestions.isEmpty)
        XCTAssertTrue(page.groups.overdue[0].overdue)
        XCTAssertEqual(page.groups.dueSoon[0].status, "partially_paid")
        XCTAssertEqual(page.groups.awaitingRefund[0].kind, "credit_note")
        XCTAssertNil(page.groups.awaitingRefund[0].dueDate)
        XCTAssertNotNil(page.suggestions[0].transaction.counterpartyName)
        XCTAssertTrue(page.list.items.contains { $0.creditorIban == nil })
    }

    func testBillOpen() throws {
        let page = try ContractTests.decode(BillDetailPage.self, "bills.id.open")
        XCTAssertEqual(page.bill.status, "open")
        XCTAssertEqual(page.bill.amount, 194_975)
        XCTAssertEqual(page.bill.referenceType, "QRR")
        XCTAssertNotNil(page.bill.documentId)
        XCTAssertEqual(page.document?.fileName, "invoice-2001.pdf")
        XCTAssertEqual(page.links.count, 1)
        XCTAssertEqual(page.suggestions.count, 1)
        XCTAssertEqual(page.dismissed.count, 1)
        XCTAssertFalse(page.candidates.items.isEmpty)
        XCTAssertEqual(page.candidates.pageCount, 3)
        XCTAssertTrue(page.candidates.items.contains { $0.counterpartyName == nil })
        XCTAssertTrue(page.allocations.isEmpty)
        XCTAssertFalse(page.accounts.isEmpty)
    }

    func testBillPartial() throws {
        let page = try ContractTests.decode(BillDetailPage.self, "bills.id.partial")
        XCTAssertEqual(page.bill.status, "partially_paid")
        XCTAssertEqual(page.bill.remaining, 35_000)
        XCTAssertEqual(page.allocations.count, 1)
        XCTAssertEqual(page.allocations[0].amount, 25_000)
        XCTAssertNil(page.document)
        XCTAssertNil(page.bill.documentId)
    }

    func testBillPaid() throws {
        let page = try ContractTests.decode(BillDetailPage.self, "bills.id.paid")
        XCTAssertEqual(page.bill.status, "paid")
        XCTAssertEqual(page.bill.taxYear, 2025)
        XCTAssertEqual(page.bill.remaining, 0)
    }

    func testBillCreditNote() throws {
        let page = try ContractTests.decode(BillDetailPage.self, "bills.id.credit-note")
        XCTAssertEqual(page.bill.kind, "credit_note")
        XCTAssertEqual(page.bill.status, "credit_due")
        XCTAssertNil(page.bill.dueDate)
        XCTAssertNil(page.bill.dueInDays)
    }

    func testBillNew() throws {
        let page = try ContractTests.decode(BillNewPage.self, "bills.new")
        XCTAssertFalse(page.accounts.isEmpty)
        XCTAssertNil(page.draft)
        XCTAssertNil(page.documentId)
        XCTAssertNil(page.extraction)
    }

    func testBillNewWithDocument() throws {
        let page = try ContractTests.decode(BillNewPage.self, "bills.new.document")
        XCTAssertEqual(page.draft?.creditorName, "Example Energy Ltd")
        XCTAssertEqual(page.draft?.amount, "1949.75")
        XCTAssertNotNil(page.documentId)
        XCTAssertEqual(page.extraction?.source, "qr")
        let values = BillFormValues.from(draft: page.draft, currency: "EUR")
        XCTAssertEqual(values.currency, "CHF")
        XCTAssertEqual(values.referenceType, "QRR")
        XCTAssertEqual(values.reference, "21 00000 00003 13947 14300 09017")
        XCTAssertEqual(values.creditorIban.filter { $0 == " " }.count, 5)
        XCTAssertTrue(values.creditorIban.hasPrefix("CH"))
    }

    func testFormFromBillAndBack() throws {
        let page = try ContractTests.decode(BillDetailPage.self, "bills.id.open")
        let values = BillFormValues.from(page.bill)
        XCTAssertEqual(values.amount, "1949.75")
        XCTAssertEqual(values.taxYear, "")
        let form = values.formFields(documentId: nil)
        let names = form.fields.map { $0.name }
        XCTAssertEqual(names.count, 14)
        XCTAssertTrue(names.contains("expectedAccountId"))
        XCTAssertFalse(names.contains("documentId"))
        XCTAssertEqual(values.formFields(documentId: "d1").fields.last?.name, "documentId")
    }

    func testMergeKeepsStoredValues() {
        var base = BillFormValues()
        base.creditorName = "Stored"
        base.amount = "10.00"
        base.currency = "EUR"
        base.kind = "credit_note"
        let draft = BillDraft(creditorName: "", amount: "20.00", currency: "CHF")
        let merged = BillFormValues.merged(base, with: draft, source: "text", hasAllocations: false)
        XCTAssertEqual(merged.creditorName, "Stored")
        XCTAssertEqual(merged.amount, "20.00")
        XCTAssertEqual(merged.currency, "EUR")
        XCTAssertEqual(merged.kind, "credit_note")
        let fromQr = BillFormValues.merged(base, with: draft, source: "qr", hasAllocations: false)
        XCTAssertEqual(fromQr.currency, "CHF")
        let locked = BillFormValues.merged(base, with: draft, source: "qr", hasAllocations: true)
        XCTAssertEqual(locked.currency, "EUR")
    }

    func testConfirmForms() {
        let list = BillForms.confirm(billId: "b1", transactionId: "t1", amount: -1250, currency: "CHF")
        XCTAssertEqual(list.fields.map { $0.name }, ["billId", "transactionId", "amount"])
        XCTAssertEqual(list.fields.last?.value, "-12.50")
        let detail = BillForms.confirm(billId: nil, transactionId: "t1", amount: 500, currency: "JPY")
        XCTAssertEqual(detail.fields.map { $0.name }, ["transactionId", "amount"])
        XCTAssertEqual(detail.fields.last?.value, "500")
        XCTAssertEqual(BillForms.dismiss(billId: nil, transactionId: "t1").fields.count, 1)
        XCTAssertEqual(BillForms.allocation("a1").fields.first?.name, "allocationId")
    }

    func testIbanAndReferenceText() {
        XCTAssertEqual(BillText.groupIban(plainGrouped.lowercased()), plainGrouped)
        XCTAssertEqual(BillText.groupIban(plain), plainGrouped)
        let dots = "\u{2022}\u{2022}\u{2022}\u{2022}"
        XCTAssertEqual(BillText.maskIban(plain), "ABCD \(dots) \(dots) \(dots) \u{2022}RST U")
        XCTAssertEqual(BillText.groupReference(String(repeating: "7", count: 27)), "77 77777 77777 77777 77777 77777")
        XCTAssertEqual(BillText.groupReference(" abc "), "abc")
        XCTAssertEqual(BillText.normalizeIban("21 00000 00003"), "2100000000003")
    }

    func testDueHints() {
        XCTAssertEqual(BillText.dueHint(dueInDays: -3, overdue: true, status: "open"), "3 days overdue")
        XCTAssertEqual(BillText.dueHint(dueInDays: -1, overdue: true, status: "open"), "1 day overdue")
        XCTAssertEqual(BillText.dueHint(dueInDays: 0, overdue: false, status: "open"), "Due today")
        XCTAssertEqual(BillText.dueHint(dueInDays: 1, overdue: false, status: "partially_paid"), "Due tomorrow")
        XCTAssertEqual(BillText.dueHint(dueInDays: 12, overdue: false, status: "open"), "Due in 12 days")
        XCTAssertNil(BillText.dueHint(dueInDays: 12, overdue: false, status: "paid"))
        XCTAssertNil(BillText.dueHint(dueInDays: nil, overdue: false, status: "open"))
    }

    func testPayableAmountAndLinks() throws {
        let partial = try ContractTests.decode(BillDetailPage.self, "bills.id.partial")
        XCTAssertEqual(BillText.payableAmount(partial.bill), 35_000)
        let paid = try ContractTests.decode(BillDetailPage.self, "bills.id.paid")
        XCTAssertNil(BillText.payableAmount(paid.bill))
        XCTAssertNotNil(BillText.webURL("https://dms.example.org/documents/2001"))
        XCTAssertNil(BillText.webURL("javascript:alert(1)"))
        XCTAssertNil(BillText.webURL(nil))
    }

    func testRedirectAndFileNames() {
        XCTAssertEqual(BillText.documentId(inRedirect: "/bills/new?document=abc-1"), "abc-1")
        XCTAssertNil(BillText.documentId(inRedirect: "/bills/new"))
        XCTAssertNil(BillText.documentId(inRedirect: nil))
        XCTAssertEqual(BillText.safeFileName("../x/invoice 1.pdf"), "invoice_1.pdf")
        XCTAssertEqual(BillText.safeFileName(""), "bill.pdf")
        XCTAssertEqual(BillText.pageRange(page: 2, pageSize: 25, total: 53), "26\u{2013}50 of 53")
        XCTAssertEqual(BillText.fileSize(3630), "4 KB")
    }

    func testDocumentPreparation() {
        XCTAssertTrue(BillDocumentFile.isPDF(Data("%PDF-1.4 x".utf8)))
        XCTAssertFalse(BillDocumentFile.isPDF(Data("hello".utf8)))
        XCTAssertEqual(BillDocumentFile.pdfName("scan.jpg"), "scan.pdf")
        let size = BillDocumentPDF.pageSize(width: 4000, height: 3000)
        XCTAssertEqual(size.width, 2000)
        XCTAssertEqual(size.height, 1500)
        let small = BillDocumentPDF.pageSize(width: 300, height: 400)
        XCTAssertEqual(small.width, 300)
    }

    @MainActor
    func testImageBecomesPDF() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 60))
        let image = renderer.image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 60))
        }
        let png = try XCTUnwrap(image.pngData())
        let document = try BillDocumentFile.prepare(data: png, name: "photo.png")
        XCTAssertEqual(document.name, "photo.pdf")
        XCTAssertTrue(BillDocumentFile.isPDF(document.data))
        XCTAssertThrowsError(try BillDocumentFile.prepare(data: Data("not a file".utf8), name: "x.txt"))
        let big = Data(count: BillDocumentFile.maxBytes + 1)
        XCTAssertThrowsError(try BillDocumentFile.prepare(data: big, name: "big.pdf"))
    }
}
