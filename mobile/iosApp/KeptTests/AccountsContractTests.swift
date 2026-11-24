import Foundation
@testable import Kept
import XCTest

final class AccountsContractTests: XCTestCase {
    // MARK: Fixtures

    func testAccountsList() throws {
        let page = try ContractTests.decode(AccountsPage.self, "accounts")
        XCTAssertFalse(page.institutions.isEmpty)
        XCTAssertGreaterThan(page.accounts.count, 5)
        XCTAssertTrue(page.accounts.contains { $0.archived })
        XCTAssertTrue(page.accounts.contains { $0.institution == nil })
        XCTAssertTrue(page.accounts.contains { $0.holdings != nil })
        XCTAssertTrue(page.accounts.contains { $0.noticeMonths != nil && $0.freeWithdrawal != nil })
        XCTAssertTrue(page.accounts.contains { $0.shareBps < 10_000 && $0.sharedWith != nil })

        let archived = AccountsLogic.archivedAccounts(page)
        XCTAssertEqual(archived.count, page.accounts.filter { $0.archived }.count)
        let groups = AccountsLogic.groups(page)
        XCTAssertGreaterThanOrEqual(groups.count, page.institutions.count)
        XCTAssertTrue(groups.contains { $0.id == "other" })
        let totals = AccountsLogic.totals(page)
        XCTAssertEqual(totals.map { $0.currency }, totals.map { $0.currency }.sorted())
        XCTAssertTrue(totals.contains { $0.currency == "CHF" && $0.shared })
    }

    func testAccountChecking() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.checking")
        XCTAssertEqual(page.account.type, "current")
        XCTAssertEqual(page.account.currency, "CHF")
        XCTAssertFalse(page.transactions.items.isEmpty)
        XCTAssertGreaterThan(page.transactions.pageCount, 1)
        XCTAssertLessThanOrEqual(page.transactions.items.count, page.transactions.pageSize)
        XCTAssertNotNil(page.focused)
        XCTAssertNotNil(page.transaction(withId: page.focused?.id ?? ""))
        XCTAssertFalse(page.categories.isEmpty)
        XCTAssertFalse(page.filters.isActive)
        XCTAssertTrue(page.transactions.items.contains { $0.transfer != nil })
        XCTAssertTrue(page.transactions.items.contains { $0.source == "manual" })
        XCTAssertFalse(page.transactionLinks.isEmpty)
        XCTAssertFalse(page.snapshots.isEmpty)
        XCTAssertNil(page.value)
        XCTAssertFalse(page.hasHoldings)
        XCTAssertFalse(page.showPortfolios)
    }

    func testAccountCheckingTax() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.checking.tax")
        XCTAssertEqual(page.filters.q, "Example Tax Office")
        XCTAssertTrue(page.filters.isActive)
        XCTAssertTrue(page.transactions.items.contains { $0.taxYear != nil })
    }

    func testAccountCheckingDonations() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.checking.donations")
        XCTAssertTrue(page.transactions.items.contains { $0.deductionYear != nil })
        XCTAssertTrue(page.transactions.items.contains { $0.categoryId != nil })
    }

    func testAccountCreditCard() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.credit-card")
        XCTAssertEqual(page.account.type, "credit_card")
        XCTAssertTrue(page.transactions.items.contains { $0.reversal })
        XCTAssertTrue(page.transactions.items.contains { $0.originalAmount != nil && $0.originalCurrency != nil })
    }

    func testAccountSavings() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.savings")
        XCTAssertEqual(page.account.noticeMonths, 3)
        XCTAssertNotNil(page.account.freeWithdrawal)
        XCTAssertTrue(page.account.fillFromTransfers)
        let mirror = page.transactions.items.first { $0.source == "mirror" }
        XCTAssertNotNil(mirror?.mirrorOf)
        XCTAssertNotNil(mirror?.transfer)
        XCTAssertGreaterThan(page.transfers.mirrorCount, 0)
    }

    func testAccountEuro() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.euro")
        XCTAssertEqual(page.account.currency, "EUR")
        XCTAssertEqual(page.transfers.needsAmount.count, 1)
        let item = try XCTUnwrap(page.transfers.needsAmount.first)
        XCTAssertEqual(item.targetCurrency, "EUR")
        XCTAssertNotNil(item.linkCandidate)
        XCTAssertEqual(item.id, item.transferId)
    }

    func testAccountInvestment() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.investment")
        XCTAssertTrue(page.hasHoldings)
        XCTAssertTrue(page.account.tradesMoveCash)
        XCTAssertNotNil(page.account.holdings)
        let valuation = try XCTUnwrap(page.value)
        XCTAssertFalse(valuation.positions.isEmpty)
        XCTAssertEqual(valuation.total, page.balance)
        XCTAssertFalse(page.securities.isEmpty)
        XCTAssertTrue(page.trades.contains { $0.side == "buy" })
        XCTAssertTrue(page.trades.contains { $0.side == "sell" })
        let split = try XCTUnwrap(page.trades.first { $0.side == "split" })
        XCTAssertEqual(split.splitNew, 2)
        XCTAssertEqual(split.splitOld, 1)
        XCTAssertEqual(
            AccountsLogic.splitTerms(quantity: split.quantity, splitNew: split.splitNew, splitOld: split.splitOld),
            AccountsSplitTerms(new: 2, old: 1)
        )
    }

    func testAccountPillar3a() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.pillar3a")
        XCTAssertTrue(page.showPortfolios)
        XCTAssertEqual(page.portfolios.count, 2)
        XCTAssertTrue(page.portfolios.contains { $0.closedOn != nil && $0.closeReason != nil })
        XCTAssertTrue(page.portfolios.contains { $0.depositReference != nil })
        XCTAssertFalse(page.portfolioValues.isEmpty)
        for portfolio in page.portfolios {
            XCTAssertNotNil(page.portfolioValues[portfolio.id])
        }
        XCTAssertGreaterThan(page.value?.portfolios ?? 0, 0)
        XCTAssertNotNil(page.account.depositIban)
        XCTAssertNotNil(page.account.contractNumber)

        let openPortfolio = try XCTUnwrap(page.portfolios.first { $0.closedOn == nil })
        XCTAssertEqual(openPortfolio.latestGain, 96_000)
        XCTAssertEqual(openPortfolio.latestGainBps, 1244)
        let closedPortfolio = try XCTUnwrap(page.portfolios.first { $0.closedOn != nil })
        XCTAssertNil(closedPortfolio.latestGain)
        XCTAssertNil(closedPortfolio.latestGainBps)
        let history = try XCTUnwrap(page.portfolioValues[openPortfolio.id])
        XCTAssertTrue(history.contains { $0.gain == 96_000 && $0.gainBps == 1244 })
        let closedHistory = try XCTUnwrap(page.portfolioValues[closedPortfolio.id])
        XCTAssertTrue(closedHistory.allSatisfy { $0.gain == nil && $0.gainBps == nil })
    }

    func testStoredFigures() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.pillar3a")
        let portfolio = try XCTUnwrap(page.portfolios.first { $0.closedOn == nil })
        let day = try XCTUnwrap(page.portfolioValues[portfolio.id]?.first { $0.gain == 96_000 }?.date)
        XCTAssertEqual(AccountsLogic.storedGains(page, date: day), [portfolio.id: "960.00"])
        XCTAssertEqual(AccountsLogic.storedReturns(page, date: day), [portfolio.id: "12.44"])
        XCTAssertTrue(AccountsLogic.storedGains(page, date: "2000-01-01").isEmpty)
        XCTAssertTrue(AccountsLogic.storedReturns(page, date: "2000-01-01").isEmpty)
        XCTAssertNil(AccountsLogic.storedValue(page, portfolioId: portfolio.id, date: "2000-01-01"))
        XCTAssertEqual(AccountsLogic.storedValue(page, portfolioId: portfolio.id, date: day)?.amount, 846_000)
    }

    /// The fixture holds no website links, checks or top-up IBANs: put some in and decode again.
    func testWebsiteCheckedAndTopUpFieldsDecode() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: ContractTests.fixture("accounts")) as? [String: Any])
        var institutions = try XCTUnwrap(object["institutions"] as? [[String: Any]])
        var accounts = try XCTUnwrap(object["accounts"] as? [[String: Any]])
        institutions[0]["websiteUrl"] = "https://www.example.com"
        accounts[0]["websiteUrl"] = "https://portal.example.com"
        accounts[0]["lastCheckedAt"] = 1_795_400_000_000
        accounts[1]["depositIban"] = Self.plain
        object["institutions"] = institutions
        object["accounts"] = accounts
        let data = try JSONSerialization.data(withJSONObject: object)
        let page = try JSONDecoder().decode(AccountsPage.self, from: data)
        XCTAssertEqual(page.institutions[0].websiteUrl, "https://www.example.com")
        XCTAssertEqual(page.accounts[0].websiteUrl, "https://portal.example.com")
        XCTAssertEqual(page.accounts[0].lastCheckedAt, 1_795_400_000_000)
        XCTAssertEqual(page.accounts[1].depositIban, Self.plain)
        XCTAssertNil(page.accounts[1].websiteUrl)
    }

    func testInstitutionRefWebsite() throws {
        let json = "{\"id\": \"i\", \"name\": \"Example Bank\", \"color\": null, \"logoVersion\": null, \"websiteUrl\": \"https://www.example.com\"}"
        let ref = try JSONDecoder().decode(InstitutionRef.self, from: Data(json.utf8))
        XCTAssertEqual(ref.websiteUrl, "https://www.example.com")
    }

    func testAccountPension() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.pension")
        XCTAssertEqual(page.account.type, "pension")
        XCTAssertEqual(page.transfers.fillSuggestion?.count, 1)
        XCTAssertTrue(page.transactions.items.isEmpty)
        XCTAssertFalse(page.snapshots.isEmpty)
    }

    func testAccountJoint() throws {
        let page = try ContractTests.decode(AccountPage.self, "accounts.id.joint")
        XCTAssertEqual(page.account.shareBps, 5000)
        XCTAssertNotNil(page.account.sharedWith)
    }

    func testAccountImports() throws {
        let page = try ContractTests.decode(AccountImportsPage.self, "accounts.id.imports")
        XCTAssertFalse(page.imports.isEmpty)
        XCTAssertTrue(page.imports.contains { !$0.warnings.isEmpty })
        for entry in page.imports {
            XCTAssertNotNil(page.impacts[entry.id])
        }
        XCTAssertTrue(page.imports.contains { $0.openingBalance != nil && $0.closingBalance != nil })
    }

    // MARK: Pure logic

    /// Not an account number: the display helpers only group and mask characters.
    private static let plain = "ABCDEFGHIJKLMNOPQRSTU"
    private static let plainGrouped = "ABCD EFGH IJKL MNOP QRST U"

    func testIbanDisplay() {
        let iban = Self.plain.lowercased()
        XCTAssertEqual(AccountsLogic.normalizeIban(iban), Self.plain)
        XCTAssertEqual(AccountsLogic.formatIban(iban), Self.plainGrouped)
        XCTAssertEqual(AccountsLogic.displayIban(iban, mode: "full"), Self.plainGrouped)
        XCTAssertNil(AccountsLogic.displayIban(iban, mode: "hidden"))
        let masked = AccountsLogic.displayIban(iban, mode: "masked") ?? ""
        XCTAssertTrue(masked.hasPrefix("ABCD "))
        XCTAssertTrue(masked.hasSuffix("\u{2022}RST U"))
        XCTAssertFalse(masked.contains("EFGH"))
    }

    /// Every string stored under `key` anywhere in a fixture.
    private static func strings(_ key: String, in fixture: String) throws -> [String] {
        var found: [String] = []
        func walk(_ value: Any) {
            if let object = value as? [String: Any] {
                for (name, child) in object {
                    if name == key, let text = child as? String { found.append(text) }
                    walk(child)
                }
            } else if let list = value as? [Any] {
                for child in list { walk(child) }
            }
        }
        walk(try JSONSerialization.jsonObject(with: ContractTests.fixture(fixture)))
        return found
    }

    /// The fixtures hold the documented example IBANs: QR-IBANs as deposit accounts, ordinary ones as accounts.
    func testQrIban() throws {
        let deposits = try Self.strings("depositIban", in: "accounts")
        let ordinary = try Self.strings("iban", in: "accounts")
        XCTAssertFalse(deposits.isEmpty)
        XCTAssertFalse(ordinary.isEmpty)
        XCTAssertTrue(deposits.allSatisfy { AccountsLogic.isQrIban($0) })
        XCTAssertFalse(ordinary.contains { AccountsLogic.isQrIban($0) })
        XCTAssertFalse(AccountsLogic.isQrIban(Self.plain))
    }

    func testReferences() {
        XCTAssertEqual(
            AccountsLogic.formatReference("000000000000000000000000218"),
            "00 00000 00000 00000 00000 00218"
        )
    }

    func testShares() {
        XCTAssertEqual(AccountsLogic.shareInput(10_000), "100")
        XCTAssertEqual(AccountsLogic.shareInput(5000), "50")
        XCTAssertEqual(AccountsLogic.shareInput(3333), "33.33")
        XCTAssertEqual(AccountsLogic.shareInput(3330), "33.3")
        XCTAssertEqual(AccountsLogic.shareInput(5), "0.05")
        XCTAssertEqual(AccountsLogic.shareText(5000), "50%")
        XCTAssertEqual(AccountsLogic.shareOf(5, 5000), 3)
        XCTAssertEqual(AccountsLogic.shareOf(-5, 5000), -3)
        XCTAssertEqual(AccountsLogic.shareOf(12_345, 10_000), 12_345)
        XCTAssertEqual(AccountsLogic.shareOf(10_001, 5000), 5001)
    }

    func testFixedPoint() {
        XCTAssertEqual(AccountsFixed.parse("12.5"), 1_250_000_000)
        XCTAssertEqual(AccountsFixed.parse("1'234,5"), 123_450_000_000)
        XCTAssertEqual(AccountsFixed.parse("0.00000001"), 1)
        XCTAssertEqual(AccountsFixed.parse("-1.5"), -150_000_000)
        XCTAssertEqual(AccountsFixed.parse("7"), 700_000_000)
        XCTAssertNil(AccountsFixed.parse("0.000000001"))
        XCTAssertNil(AccountsFixed.parse("abc"))
        XCTAssertNil(AccountsFixed.parse(""))
        XCTAssertNil(AccountsFixed.parse("1.2.3"))
        XCTAssertNil(AccountsFixed.parse("1."))

        XCTAssertEqual(AccountsFixed.input(150_000_000), "1.5")
        XCTAssertEqual(AccountsFixed.input(100_000_000), "1")
        XCTAssertEqual(AccountsFixed.input(1), "0.00000001")
        XCTAssertEqual(AccountsFixed.input(-250_000_000), "-2.5")
        XCTAssertEqual(AccountsFixed.input(0), "0")
        for value: Int64 in [1, 99, 150_000_000, 123_456_789_012, 5_400_000_000] {
            XCTAssertEqual(AccountsFixed.parse(AccountsFixed.input(value)), value)
        }
    }

    func testFixedDisplay() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(AccountsFixed.display(150_000_000, locale: locale), "1.5")
        XCTAssertEqual(AccountsFixed.display(200_000_000, locale: locale), "2")
        XCTAssertEqual(AccountsFixed.display(200_000_000, locale: locale, minFraction: 2), "2.00")
        XCTAssertEqual(AccountsFixed.display(123_456_789_012, locale: locale), "1,234.56789012")
        XCTAssertEqual(AccountsFixed.display(-50_000_000, locale: locale), "-0.5")
    }

    func testTradeValue() {
        XCTAssertEqual(AccountsFixed.value(quantity: 600_000_000, price: 5_500_000_000, currency: "CHF"), 33_000)
        XCTAssertEqual(AccountsFixed.value(quantity: 150_000_000, price: 100_000_000, currency: "CHF"), 150)
        XCTAssertEqual(AccountsFixed.value(quantity: 1, price: 100_000_000, currency: "CHF"), 0)
        XCTAssertEqual(AccountsFixed.value(quantity: 50_000_000, price: 100_000_000, currency: "JPY"), 1)
        XCTAssertEqual(
            AccountsFixed.suggestedAmount(quantity: "6", price: "55", fees: "1.50", side: "buy", currency: "CHF"),
            "331.50"
        )
        XCTAssertEqual(
            AccountsFixed.suggestedAmount(quantity: "6", price: "55", fees: "1.50", side: "sell", currency: "CHF"),
            "328.50"
        )
        XCTAssertEqual(
            AccountsFixed.suggestedAmount(quantity: "6", price: "55", fees: "", side: "buy", currency: "CHF"),
            "330.00"
        )
        XCTAssertNil(AccountsFixed.suggestedAmount(quantity: "", price: "55", fees: "", side: "buy", currency: "CHF"))
        XCTAssertNil(AccountsFixed.suggestedAmount(quantity: "6", price: "55", fees: "x", side: "buy", currency: "CHF"))
        XCTAssertNil(AccountsFixed.suggestedAmount(quantity: "0", price: "55", fees: "", side: "buy", currency: "CHF"))
    }

    func testAmountParsing() {
        XCTAssertEqual(AccountsAmount.parse("1'234.50", decimals: 2), 123_450)
        XCTAssertEqual(AccountsAmount.parse("12,5", decimals: 2), 1250)
        XCTAssertEqual(AccountsAmount.parse("-0.05", decimals: 2), -5)
        XCTAssertEqual(AccountsAmount.parse("500", decimals: 0), 500)
        XCTAssertNil(AccountsAmount.parse("1.234", decimals: 2))
        XCTAssertNil(AccountsAmount.parse("", decimals: 2))
        XCTAssertNil(AccountsAmount.parse("1 2 x", decimals: 2))
    }

    func testSplitTerms() {
        XCTAssertEqual(
            AccountsLogic.splitTerms(quantity: 10_000_000, splitNew: nil, splitOld: nil),
            AccountsSplitTerms(new: 1, old: 10)
        )
        XCTAssertEqual(
            AccountsLogic.splitTerms(quantity: 300_000_000, splitNew: nil, splitOld: nil),
            AccountsSplitTerms(new: 3, old: 1)
        )
        XCTAssertNil(AccountsLogic.splitTerms(quantity: 150_000_000, splitNew: nil, splitOld: nil))
    }

    func testStaleHint() {
        let now: Int64 = 1_800_000_000_000
        let day: Int64 = 86_400_000
        XCTAssertNil(AccountsLogic.staleHint(lastImportAt: nil, now: now))
        XCTAssertNil(AccountsLogic.staleHint(lastImportAt: now - 10 * day, now: now))
        XCTAssertEqual(AccountsLogic.staleHint(lastImportAt: now - 50 * day, now: now), "50 days ago")
        XCTAssertEqual(AccountsLogic.staleHint(lastImportAt: now - 100 * day, now: now), "3 months ago")
        XCTAssertEqual(AccountsLogic.staleHint(lastImportAt: now - 800 * day, now: now), "2 years ago")
    }

    func testStaleLabel() {
        let now: Int64 = 1_800_000_000_000
        let day: Int64 = 86_400_000
        XCTAssertNil(AccountsLogic.staleLabel(lastImportAt: nil, lastCheckedAt: now, now: now))
        XCTAssertNil(AccountsLogic.staleLabel(lastImportAt: now - 10 * day, lastCheckedAt: nil, now: now))
        XCTAssertEqual(
            AccountsLogic.staleLabel(lastImportAt: now - 50 * day, lastCheckedAt: nil, now: now),
            "Last import 50 days ago"
        )
        XCTAssertEqual(
            AccountsLogic.staleLabel(lastImportAt: now - 100 * day, lastCheckedAt: now - 50 * day, now: now),
            "Last checked 50 days ago"
        )
        XCTAssertNil(AccountsLogic.staleLabel(lastImportAt: now - 100 * day, lastCheckedAt: now - 10 * day, now: now))
        XCTAssertEqual(
            AccountsLogic.staleLabel(lastImportAt: now - 100 * day, lastCheckedAt: now - 120 * day, now: now),
            "Last import 3 months ago"
        )
    }

    func testStaleDaysLabel() {
        XCTAssertEqual(
            AccountsLogic.staleDaysLabel(lastImportAt: 1, lastCheckedAt: nil, staleDays: 50),
            "Last import 50 days ago"
        )
        XCTAssertEqual(
            AccountsLogic.staleDaysLabel(lastImportAt: 1, lastCheckedAt: 2, staleDays: 1),
            "Last checked 1 day ago"
        )
        XCTAssertNil(AccountsLogic.staleDaysLabel(lastImportAt: nil, lastCheckedAt: 2, staleDays: 5))
        XCTAssertNil(AccountsLogic.staleDaysLabel(lastImportAt: 1, lastCheckedAt: nil, staleDays: nil))
    }

    func testPortalURL() {
        XCTAssertEqual(
            AccountsLogic.portalURL(own: "https://portal.example.com", institution: "https://www.example.com")?.absoluteString,
            "https://portal.example.com"
        )
        XCTAssertEqual(
            AccountsLogic.portalURL(own: nil, institution: "https://www.example.com")?.absoluteString,
            "https://www.example.com"
        )
        XCTAssertNil(AccountsLogic.portalURL(own: nil, institution: nil))
        XCTAssertNil(AccountsLogic.portalURL(own: "javascript:alert(1)", institution: "https://www.example.com"))
        XCTAssertNil(AccountsLogic.webURL(""))
    }

    private func field(_ form: FormFields, _ name: String) -> String? {
        form.fields.first { $0.name == name }?.value
    }

    func testIbanAndLinkFields() {
        var other = FormFields()
        AccountsLogic.setIbanAndLinkFields(&other, is3a: false, depositIban: "", websiteUrl: "")
        XCTAssertEqual(field(other, "depositIban"), "")
        XCTAssertEqual(field(other, "depositIbanField"), "1")
        XCTAssertEqual(field(other, "websiteUrl"), "")

        var pillar = FormFields()
        AccountsLogic.setIbanAndLinkFields(&pillar, is3a: true, depositIban: Self.plain, websiteUrl: "https://www.example.com")
        XCTAssertEqual(field(pillar, "depositIban"), Self.plain)
        XCTAssertNil(field(pillar, "depositIbanField"))
        XCTAssertEqual(field(pillar, "websiteUrl"), "https://www.example.com")
    }

    func testPercentAndReturn() {
        XCTAssertEqual(AccountsLogic.percentInput(1244), "12.44")
        XCTAssertEqual(AccountsLogic.percentInput(1000), "10.00")
        XCTAssertEqual(AccountsLogic.percentInput(-5), "-0.05")
        XCTAssertEqual(AccountsLogic.percentInput(0), "0.00")
        XCTAssertEqual(AccountsLogic.percentInput(-1244), "-12.44")

        XCTAssertEqual(AccountsLogic.returnBps(amount: 846_000, gain: 96_000, gainBps: 1244), 1244)
        XCTAssertEqual(AccountsLogic.returnBps(amount: 11_000, gain: 1_000, gainBps: nil), 1000)
        XCTAssertEqual(AccountsLogic.returnBps(amount: 9_000, gain: -1_000, gainBps: nil), -1000)
        XCTAssertEqual(AccountsLogic.returnBps(amount: 2, gain: -1, gainBps: nil), -3333)
        XCTAssertEqual(AccountsLogic.returnBps(amount: 20_001, gain: 1, gainBps: nil), 1)
        XCTAssertNil(AccountsLogic.returnBps(amount: 100, gain: 100, gainBps: nil))
        XCTAssertNil(AccountsLogic.returnBps(amount: 100, gain: 150, gainBps: nil))
        XCTAssertNil(AccountsLogic.returnBps(amount: 100, gain: nil, gainBps: nil))
    }

    func testSignedPercent() {
        let formats = Formats(localeTag: "en-GB")
        XCTAssertEqual(formats.signedPercent(basisPoints: 425), "+4.25%")
        XCTAssertEqual(formats.signedPercent(basisPoints: 0), "0.00%")
        XCTAssertEqual(formats.signedPercent(basisPoints: -1244), "-12.44%")
    }

    func testPortfolioValuesForm() {
        let form = AccountsLogic.portfolioValuesForm(
            date: "2026-11-20",
            note: "Statement",
            portfolioIds: ["a", "b"],
            values: ["a": "8'500.00"],
            gains: ["a": "-120.50"],
            percents: ["a": "-1.4"]
        )
        XCTAssertEqual(field(form, "date"), "2026-11-20")
        XCTAssertEqual(field(form, "note"), "Statement")
        XCTAssertEqual(field(form, "value:a"), "8'500.00")
        XCTAssertEqual(field(form, "gain:a"), "-120.50")
        XCTAssertEqual(field(form, "gainPercent:a"), "-1.4")
        XCTAssertEqual(field(form, "value:b"), "")
        XCTAssertEqual(field(form, "gain:b"), "")
        XCTAssertEqual(field(form, "gainPercent:b"), "")
        XCTAssertEqual(form.fields.count, 8)
    }

    func testTransferSummary() {
        XCTAssertNil(AccountsLogic.transferSummary(linked: 0, mirrored: 0, needsAmount: 0))
        XCTAssertEqual(
            AccountsLogic.transferSummary(linked: 1, mirrored: 2, needsAmount: 1),
            "1 transfer linked, 2 transactions filled in, 1 transfer needs an amount"
        )
        XCTAssertEqual(
            AccountsLogic.transferSummary(linked: 0, mirrored: 0, needsAmount: 3),
            "3 transfers need an amount"
        )
    }

    func testCategoryLabel() throws {
        let json = """
        [
          {"id": "p", "name": "Home", "parentId": null, "kind": "expense", "color": null, "icon": null},
          {"id": "c", "name": "Rent", "parentId": "p", "kind": "expense", "color": "#112233", "icon": "house"}
        ]
        """
        let all = try JSONDecoder().decode([AccountPage.Category].self, from: Data(json.utf8))
        XCTAssertEqual(AccountsLogic.categoryLabel(all[0], all), "Home")
        XCTAssertEqual(AccountsLogic.categoryLabel(all[1], all), "Home / Rent")
        XCTAssertEqual(AccountsLogic.sortedCategories(all).map { $0.id }, ["p", "c"])
    }

    func testImpactLines() throws {
        let json = """
        {"transactions": 5, "categorized": 3, "notes": 1, "taxYears": 0, "deductionYears": 0,
         "billAllocations": 2, "pillar3a": 0, "transferLinks": 0, "mirrors": 1}
        """
        let impact = try JSONDecoder().decode(AccountImportsPage.Impact.self, from: Data(json.utf8))
        XCTAssertEqual(
            AccountsLogic.describeImpact(impact),
            ["3 categorized transactions", "1 note", "2 transactions matched to bills", "1 mirrored transfer row"]
        )
    }

    func testCandidatesAndLabels() throws {
        let json = """
        {"success": true, "action": "transferCandidates", "transactionId": "t",
         "candidates": [{"id": "x", "accountId": "a", "accountName": "Other", "bookingDate": "2026-01-02",
           "amount": 1000, "currency": "CHF", "counterpartyName": null, "description": null, "exact": true, "days": 0}]}
        """
        let decoded = try JSONDecoder().decode(AccountTransferCandidates.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.candidates.count, 1)
        XCTAssertEqual(AccountsLogic.daysApartText(0), "same day")
        XCTAssertEqual(AccountsLogic.daysApartText(1), "1 day apart")
        XCTAssertEqual(AccountsLogic.daysApartText(3), "3 days apart")

        let fill = try JSONDecoder().decode(
            AccountFillResult.self,
            from: Data("{\"success\": true, \"paired\": 1, \"mirrored\": 0, \"needsAmount\": 2}".utf8)
        )
        XCTAssertEqual(fill.needsAmount, 2)
        XCTAssertEqual(AccountsLogic.typeLabel("pillar_3a"), "Pillar 3a")
        XCTAssertEqual(AccountsLogic.formatLabel("camt053"), "camt.053")
        XCTAssertEqual(AccountsLogic.closeReasonLabel("wef"), "Home ownership (WEF)")
    }
}
