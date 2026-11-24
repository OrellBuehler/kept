import Foundation

struct AccountsGroup: Identifiable {
    let id: String
    let institution: AccountsPage.Institution?
    let accounts: [AccountsPage.Account]
}

struct AccountsTotal: Identifiable {
    let currency: String
    let sum: Int64
    let share: Int64
    let shared: Bool
    var id: String { currency }
}

struct AccountsSplitTerms: Equatable {
    let new: Int64
    let old: Int64
}

/// Pure helpers of the accounts screens (no UI, no state), so tests can call them.
enum AccountsLogic {
    static let fullShareBps = 10_000

    static let accountTypes: [(value: String, label: String)] = [
        ("current", "Current"),
        ("savings", "Savings"),
        ("credit_card", "Credit card"),
        ("investment", "Investment"),
        ("pension", "Pension"),
        ("pillar_3a", "Pillar 3a"),
        ("cash", "Cash"),
        ("other", "Other"),
    ]

    static let noticeTypes: [String] = ["current", "savings", "cash", "other"]

    static func typeLabel(_ type: String) -> String {
        for entry in accountTypes where entry.value == type {
            return entry.label
        }
        return type
    }

    static func hasNotice(_ type: String) -> Bool {
        return noticeTypes.contains(type)
    }

    static func plural(_ count: Int, _ one: String) -> String {
        return count == 1 ? "\(count) \(one)" : "\(count) \(one)s"
    }

    // MARK: IBAN and references

    static func normalizeIban(_ input: String) -> String {
        let parts = input.split(whereSeparator: { $0.isWhitespace })
        return parts.joined().uppercased()
    }

    private static func groupsOfFour(_ text: String) -> String {
        var result = ""
        var count = 0
        for character in text {
            if count > 0 && count % 4 == 0 { result.append(" ") }
            result.append(character)
            count += 1
        }
        return result
    }

    static func formatIban(_ input: String) -> String {
        return groupsOfFour(normalizeIban(input))
    }

    static func maskIban(_ input: String) -> String {
        let iban = normalizeIban(input)
        let characters = Array(iban)
        if characters.count < 12 {
            return groupsOfFour(String(repeating: "\u{2022}", count: characters.count))
        }
        let head = String(characters.prefix(4))
        let tail = String(characters.suffix(4))
        let dots = String(repeating: "\u{2022}", count: characters.count - 8)
        return groupsOfFour(head + dots + tail)
    }

    /// The IBAN as the user's "IBAN display" preference shows it: "full", "masked" or "hidden" (nil).
    static func displayIban(_ iban: String, mode: String) -> String? {
        if mode == "hidden" { return nil }
        if mode == "masked" { return maskIban(iban) }
        return formatIban(iban)
    }

    /// A payment reference grouped for reading: QR references as "21 00000 ...", ISO 11649 in blocks of four.
    static func formatReference(_ input: String) -> String {
        let reference = normalizeIban(input)
        let characters = Array(reference)
        let allDigits = characters.allSatisfy { $0.isASCII && $0.isNumber }
        if characters.count == 27 && allDigits {
            var result = String(characters.prefix(2))
            let rest = Array(characters.dropFirst(2))
            var index = 0
            while index < rest.count {
                let end = Swift.min(index + 5, rest.count)
                result += " " + String(rest[index ..< end])
                index = end
            }
            return result
        }
        if reference.hasPrefix("RF") && characters.count > 3 {
            return groupsOfFour(reference)
        }
        return input.trimmingCharacters(in: .whitespaces)
    }

    // MARK: Shares

    /// 5000 -> "50", 3333 -> "33.33", 3330 -> "33.3".
    static func shareInput(_ basisPoints: Int) -> String {
        let whole = basisPoints / 100
        let fraction = basisPoints % 100
        if fraction == 0 { return "\(whole)" }
        var digits = fraction < 10 ? "0\(fraction)" : "\(fraction)"
        if digits.hasSuffix("0") { digits.removeLast() }
        return "\(whole).\(digits)"
    }

    static func shareText(_ basisPoints: Int) -> String {
        return shareInput(basisPoints) + "%"
    }

    /// `basisPoints / 10000` of an amount, rounded half away from zero.
    static func shareOf(_ amount: Int64, _ basisPoints: Int) -> Int64 {
        if basisPoints == fullShareBps { return amount }
        let magnitude = Int128(amount.magnitude)
        let product = magnitude * Int128(basisPoints)
        let rounded = (product + 5_000) / 10_000
        let value = Int64(rounded)
        return amount < 0 ? -value : value
    }

    // MARK: Lists

    static func activeAccounts(_ page: AccountsPage) -> [AccountsPage.Account] {
        return page.accounts.filter { !$0.archived }
    }

    static func archivedAccounts(_ page: AccountsPage) -> [AccountsPage.Account] {
        return page.accounts.filter { $0.archived }
    }

    /// Active accounts by institution (every institution, even empty), then the ones without.
    static func groups(_ page: AccountsPage) -> [AccountsGroup] {
        let active = activeAccounts(page)
        var result: [AccountsGroup] = []
        for institution in page.institutions {
            let own = active.filter { $0.institution?.id == institution.id }
            result.append(AccountsGroup(id: institution.id, institution: institution, accounts: own))
        }
        let other = active.filter { $0.institution == nil }
        if !other.isEmpty {
            result.append(AccountsGroup(id: "other", institution: nil, accounts: other))
        }
        return result
    }

    /// Sum of the active accounts per currency, at full amounts and at the user's share.
    static func totals(_ page: AccountsPage) -> [AccountsTotal] {
        let active = activeAccounts(page)
        let currencies = Set(active.map { $0.currency }).sorted()
        var result: [AccountsTotal] = []
        for currency in currencies {
            let inCurrency = active.filter { $0.currency == currency }
            var sum: Int64 = 0
            var share: Int64 = 0
            var shared = false
            for account in inCurrency {
                sum += account.balance
                share += account.shareBalance
                if account.shareBps < fullShareBps { shared = true }
            }
            result.append(AccountsTotal(currency: currency, sum: sum, share: share, shared: shared))
        }
        return result
    }

    static let staleDays = 45

    static func daysSince(_ milliseconds: Int64, now: Int64) -> Int {
        return Int((now - milliseconds) / 86_400_000)
    }

    /// "12 days ago", "3 months ago": coarse, for staleness hints.
    static func agoText(days: Int) -> String {
        let clamped = Swift.max(0, days)
        if clamped < 60 { return clamped == 1 ? "1 day ago" : "\(clamped) days ago" }
        if clamped < 730 {
            let months = Int(Double(clamped) / 30.4)
            return months == 1 ? "1 month ago" : "\(months) months ago"
        }
        let years = clamped / 365
        return years == 1 ? "1 year ago" : "\(years) years ago"
    }

    /// The "last import" hint of an account that has not been imported into for a while; nil otherwise.
    static func staleHint(lastImportAt: Int64?, now: Int64) -> String? {
        guard let lastImportAt else { return nil }
        let days = daysSince(lastImportAt, now: now)
        if days <= staleDays { return nil }
        return agoText(days: days)
    }

    /// "Last import 3 months ago" or, when the user confirmed there is nothing new since, "Last checked 50 days ago":
    /// the later of the two counts. Nil until that is older than `staleDays`.
    static func staleLabel(lastImportAt: Int64?, lastCheckedAt: Int64?, now: Int64) -> String? {
        guard let lastImportAt else { return nil }
        var freshAt = lastImportAt
        var prefix = "Last import"
        if let lastCheckedAt, lastCheckedAt > lastImportAt {
            freshAt = lastCheckedAt
            prefix = "Last checked"
        }
        guard let ago = staleHint(lastImportAt: freshAt, now: now) else { return nil }
        return prefix + " " + ago
    }

    /// The dashboard's wording from the server's `staleDays`, which already counts the later of import and check.
    static func staleDaysLabel(lastImportAt: Int64?, lastCheckedAt: Int64?, staleDays: Int?) -> String? {
        guard let lastImportAt, let staleDays else { return nil }
        let prefix = (lastCheckedAt ?? 0) > lastImportAt ? "Last checked" : "Last import"
        return prefix + " " + plural(staleDays, "day") + " ago"
    }

    // MARK: Website links

    /// A link the app opens: http(s) only.
    static func webURL(_ text: String?) -> URL? {
        return BillText.webURL(text)
    }

    /// The account's own web link, else its institution's.
    static func portalURL(own: String?, institution: String?) -> URL? {
        return webURL(own ?? institution)
    }

    /// What the account form posts for the IBAN to pay into and the portal link. Pillar 3a posts its deposit IBAN as
    /// before; any other type posts the top-up IBAN with `depositIbanField`, so that an empty value clears it.
    static func setIbanAndLinkFields(_ form: inout FormFields, is3a: Bool, depositIban: String, websiteUrl: String) {
        form.set("depositIban", depositIban)
        if !is3a { form.set("depositIbanField", "1") }
        form.set("websiteUrl", websiteUrl)
    }

    // MARK: Categories and transactions

    /// "Parent / Child" for subcategories, otherwise the name.
    static func categoryLabel(_ category: AccountPage.Category, _ all: [AccountPage.Category]) -> String {
        if let parentId = category.parentId, let parent = all.first(where: { $0.id == parentId }) {
            return parent.name + " / " + category.name
        }
        return category.name
    }

    /// Categories sorted by their label, for a picker.
    static func sortedCategories(_ all: [AccountPage.Category]) -> [AccountPage.Category] {
        return all.sorted { left, right in
            categoryLabel(left, all).localizedCaseInsensitiveCompare(categoryLabel(right, all)) == .orderedAscending
        }
    }

    static func title(_ transaction: AccountPage.Tx) -> String {
        if let name = transaction.counterpartyName, !name.isEmpty { return name }
        if let description = transaction.description, !description.isEmpty { return description }
        return "No description"
    }

    static func subtitle(_ transaction: AccountPage.Tx) -> String? {
        guard let name = transaction.counterpartyName, !name.isEmpty else { return nil }
        guard let description = transaction.description, !description.isEmpty else { return nil }
        return description
    }

    static func sourceLabel(_ source: String) -> String {
        if source == "manual" { return "manual" }
        if source == "mirror" { return "mirrored" }
        return "imported"
    }

    /// Imported rows and mirrors can only have their note changed.
    static func isLocked(_ transaction: AccountPage.Tx) -> Bool {
        return transaction.source != "manual"
    }

    static func transferLabel(_ transfer: AccountPage.Tx.TransferLink) -> String {
        let prefix = transfer.direction == "out" ? "To " : "From "
        return prefix + transfer.peerAccountName
    }

    // MARK: Transfers

    /// One line: what linking transfers did. Nil when nothing happened.
    static func transferSummary(linked: Int, mirrored: Int, needsAmount: Int) -> String? {
        var parts: [String] = []
        if linked > 0 { parts.append(plural(linked, "transfer") + " linked") }
        if mirrored > 0 { parts.append(plural(mirrored, "transaction") + " filled in") }
        if needsAmount > 0 {
            let verb = needsAmount == 1 ? "needs" : "need"
            parts.append(plural(needsAmount, "transfer") + " " + verb + " an amount")
        }
        if parts.isEmpty { return nil }
        return parts.joined(separator: ", ")
    }

    static func daysApartText(_ days: Int) -> String {
        if days == 0 { return "same day" }
        return plural(days, "day") + " apart"
    }

    // MARK: Imports

    static let formatLabels: [String: String] = [
        "camt053": "camt.053",
        "camt054": "camt.054",
        "mt940": "MT940",
        "csv": "CSV",
        "xlsx": "Excel",
    ]

    static func formatLabel(_ format: String) -> String {
        return formatLabels[format] ?? format
    }

    /// One line per kind of edit that undoing an import would delete.
    static func describeImpact(_ impact: AccountImportsPage.Impact) -> [String] {
        var lines: [String] = []
        if impact.categorized > 0 { lines.append(plural(impact.categorized, "categorized transaction")) }
        if impact.notes > 0 { lines.append(plural(impact.notes, "note")) }
        if impact.taxYears > 0 { lines.append(plural(impact.taxYears, "tax year assignment")) }
        if impact.deductionYears > 0 { lines.append(plural(impact.deductionYears, "deduction year assignment")) }
        if impact.billAllocations > 0 { lines.append(plural(impact.billAllocations, "transaction") + " matched to bills") }
        if impact.pillar3a > 0 { lines.append(plural(impact.pillar3a, "pillar 3a annotation")) }
        if impact.transferLinks > 0 { lines.append(plural(impact.transferLinks, "transfer link")) }
        if impact.mirrors > 0 { lines.append(plural(impact.mirrors, "mirrored transfer row")) }
        return lines
    }

    // MARK: Trades

    static let tradeSides: [(value: String, label: String)] = [
        ("buy", "Buy"),
        ("sell", "Sell"),
        ("split", "Split"),
    ]

    static func sideLabel(_ side: String) -> String {
        for entry in tradeSides where entry.value == side {
            return entry.label
        }
        return side
    }

    static func priceSourceLabel(_ source: String) -> String {
        if source == "manual" { return "manual" }
        if source == "provider" { return "fetched" }
        return "last trade"
    }

    /// The `new : old` terms of a split for display and editing; nil when only an approximate ratio is known.
    static func splitTerms(quantity: Int64, splitNew: Int64?, splitOld: Int64?) -> AccountsSplitTerms? {
        if let splitNew, let splitOld, splitNew > 0, splitOld > 0 {
            return AccountsSplitTerms(new: splitNew, old: splitOld)
        }
        let scale: Int64 = 100_000_000
        if quantity >= scale && quantity % scale == 0 {
            return AccountsSplitTerms(new: quantity / scale, old: 1)
        }
        if quantity > 0 && scale % quantity == 0 {
            return AccountsSplitTerms(new: 1, old: scale / quantity)
        }
        return nil
    }

    // MARK: Portfolios

    static let closeReasons: [(value: String, label: String)] = [
        ("age", "Retirement (age benefit)"),
        ("wef", "Home ownership (WEF)"),
        ("self_employment", "Start of self-employment"),
        ("emigration", "Emigration"),
        ("transfer", "Transfer to another provider"),
        ("disability", "Full disability"),
        ("death", "Death"),
        ("other", "Other"),
    ]

    static func closeReasonLabel(_ reason: String) -> String {
        for entry in closeReasons where entry.value == reason {
            return entry.label
        }
        return reason
    }

    /// Hundredths of a percent as the text the form posts: 1244 -> "12.44", -5 -> "-0.05".
    static func percentInput(_ basisPoints: Int) -> String {
        let magnitude = basisPoints.magnitude
        let whole = magnitude / 100
        let fraction = magnitude % 100
        let digits = fraction < 10 ? "0\(fraction)" : "\(fraction)"
        return (basisPoints < 0 ? "-" : "") + "\(whole).\(digits)"
    }

    /// Total return of a portfolio value in hundredths of a percent: the provider's own figure, else the reported gain
    /// over the capital it grew from (`amount - gain`), rounded half up. Nil without a gain or without positive capital.
    static func returnBps(amount: Int64, gain: Int64?, gainBps: Int?) -> Int? {
        if let gainBps { return gainBps }
        guard let gain else { return nil }
        let base = Int128(amount) - Int128(gain)
        if base <= 0 { return nil }
        let numerator = Int128(gain) * 20_000 + base
        let denominator = base * 2
        var quotient = numerator / denominator
        if numerator % denominator < 0 { quotient -= 1 }
        return Int(exactly: quotient)
    }

    /// The value a portfolio has on a day, if any.
    static func storedValue(_ page: AccountPage, portfolioId: String, date: String) -> AccountPage.PortfolioValue? {
        return page.portfolioValues[portfolioId]?.first(where: { $0.date == date })
    }

    /// The gain texts of the "update values" form for a day: what the day already holds, blank otherwise.
    static func storedGains(_ page: AccountPage, date: String) -> [String: String] {
        var result: [String: String] = [:]
        for portfolio in page.portfolios where portfolio.closedOn == nil {
            if let gain = storedValue(page, portfolioId: portfolio.id, date: date)?.gain {
                result[portfolio.id] = Formats.amountInput(gain, page.account.currency)
            }
        }
        return result
    }

    /// The return texts (percent) of the "update values" form for a day, like `storedGains`.
    static func storedReturns(_ page: AccountPage, date: String) -> [String: String] {
        var result: [String: String] = [:]
        for portfolio in page.portfolios where portfolio.closedOn == nil {
            if let bps = storedValue(page, portfolioId: portfolio.id, date: date)?.gainBps {
                result[portfolio.id] = percentInput(bps)
            }
        }
        return result
    }

    /// The form of "setPortfolioValues". Every open portfolio sends its value, gain and return; a blank gain or return
    /// clears what the day holds, a blank value skips the portfolio.
    static func portfolioValuesForm(
        date: String,
        note: String,
        portfolioIds: [String],
        values: [String: String],
        gains: [String: String],
        percents: [String: String]
    ) -> FormFields {
        var form = FormFields()
        form.set("date", date)
        form.set("note", note)
        for id in portfolioIds {
            form.set("value:" + id, values[id] ?? "")
            form.set("gain:" + id, gains[id] ?? "")
            form.set("gainPercent:" + id, percents[id] ?? "")
        }
        return form
    }

    /// QR-IBANs are CH/LI IBANs whose institution id (digits 5 to 9) is 30000 to 31999.
    static func isQrIban(_ input: String) -> Bool {
        let iban = Array(normalizeIban(input))
        if iban.count != 21 { return false }
        let country = String(iban.prefix(2))
        if country != "CH" && country != "LI" { return false }
        let digits = iban.dropFirst(2)
        if !digits.allSatisfy({ $0.isASCII && $0.isNumber }) { return false }
        let institution = Int(String(iban[4 ..< 9])) ?? 0
        return institution >= 30_000 && institution <= 31_999
    }
}

/// Plain decimal amounts typed by the user, in integer arithmetic.
enum AccountsAmount {
    /// "1'234.50", "1 234,50" or "-12.3" as minor units; nil when it is not an amount or has too many decimals.
    static func parse(_ input: String, decimals: Int) -> Int64? {
        guard let parsed = AccountsDecimal.parse(input, decimals: decimals) else { return nil }
        return parsed
    }
}

/// Fixed-point numbers scaled by 10^8 (quantities, unit prices), like the web's `quantity.ts`.
enum AccountsFixed {
    static let scale: Int64 = 100_000_000
    static let decimals = 8

    /// "12.5", "1'234,5" or "0.00000001" (at most 8 decimals) as a scaled integer; nil when invalid.
    static func parse(_ input: String) -> Int64? {
        return AccountsDecimal.parse(input, decimals: decimals)
    }

    /// 150_000_000 -> "1.5": what an input field is filled with (round-trips with `parse`).
    static func input(_ value: Int64) -> String {
        let negative = value < 0
        let magnitude = value.magnitude
        let whole = magnitude / UInt64(scale)
        var fraction = String(magnitude % UInt64(scale))
        while fraction.count < decimals { fraction = "0" + fraction }
        while fraction.hasSuffix("0") { fraction.removeLast() }
        var text = negative ? "-" : ""
        text += String(whole)
        if !fraction.isEmpty { text += "." + fraction }
        return text
    }

    /// The number for display with the locale's separators: at least `minFraction`, at most 8 decimals.
    static func display(_ value: Int64, locale: Locale, minFraction: Int = 0) -> String {
        let negative = value < 0
        let magnitude = value.magnitude
        let whole = Int64(magnitude / UInt64(scale))
        var fraction = String(magnitude % UInt64(scale))
        while fraction.count < decimals { fraction = "0" + fraction }
        while fraction.hasSuffix("0") { fraction.removeLast() }
        while fraction.count < minFraction { fraction += "0" }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        let wholeText = formatter.string(from: NSNumber(value: whole)) ?? String(whole)
        var text = negative ? "-" : ""
        text += wholeText
        if !fraction.isEmpty {
            let separator = locale.decimalSeparator ?? "."
            text += separator + fraction
        }
        return text
    }

    /// `quantity * price` in `currency`'s minor units (both scaled by 10^8), rounded half away from zero.
    static func value(quantity: Int64, price: Int64, currency: String) -> Int64? {
        let exponent = Formats.exponent(currency)
        var minorScale: Int128 = 1
        var index = 0
        while index < exponent {
            minorScale *= 10
            index += 1
        }
        let product = Int128(quantity.magnitude) * Int128(price.magnitude) * minorScale
        let divisor: Int128 = 10_000_000_000_000_000
        let rounded = (product + divisor / 2) / divisor
        if rounded > Int128(Int64.max) { return nil }
        let result = Int64(rounded)
        let negative = (quantity < 0) != (price < 0)
        return negative ? -result : result
    }

    /// The cash amount of a trade filled in from quantity, price and fees (the server stays the source of truth);
    /// nil when an input is not a number, or the result is not positive. Only for a security in the account's currency.
    static func suggestedAmount(quantity: String, price: String, fees: String, side: String, currency: String) -> String? {
        guard let parsedQuantity = parse(quantity), let parsedPrice = parse(price) else { return nil }
        guard let gross = value(quantity: parsedQuantity, price: parsedPrice, currency: currency) else { return nil }
        var fee: Int64 = 0
        let trimmed = fees.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            guard let parsedFee = AccountsAmount.parse(trimmed, decimals: Formats.exponent(currency)) else { return nil }
            fee = parsedFee
        }
        let total = side == "buy" ? gross + fee : gross - fee
        if total <= 0 { return nil }
        return Formats.amountInput(total, currency)
    }
}

enum AccountsDecimal {
    /// A decimal string with an optional sign and `.` or `,` as separator, scaled by 10^decimals.
    static func parse(_ input: String, decimals: Int) -> Int64? {
        var cleaned = ""
        for character in input {
            if character.isWhitespace || character == "'" || character == "\u{2019}" { continue }
            cleaned.append(character)
        }
        var negative = false
        if cleaned.hasPrefix("-") {
            negative = true
            cleaned.removeFirst()
        } else if cleaned.hasPrefix("+") {
            cleaned.removeFirst()
        }
        if cleaned.isEmpty { return nil }
        var wholeDigits = ""
        var fractionDigits = ""
        var seenSeparator = false
        for character in cleaned {
            if character == "." || character == "," {
                if seenSeparator { return nil }
                seenSeparator = true
            } else if character.isASCII && character.isNumber {
                if seenSeparator { fractionDigits.append(character) } else { wholeDigits.append(character) }
            } else {
                return nil
            }
        }
        if wholeDigits.isEmpty { return nil }
        if seenSeparator && fractionDigits.isEmpty { return nil }
        if fractionDigits.count > decimals { return nil }
        while fractionDigits.count < decimals { fractionDigits.append("0") }
        let combined = wholeDigits + fractionDigits
        guard let magnitude = Int64(combined), magnitude <= 9_007_199_254_740_991 else { return nil }
        return negative ? -magnitude : magnitude
    }
}
