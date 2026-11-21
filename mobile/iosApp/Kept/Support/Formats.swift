import Foundation
import SwiftUI

/// Amounts, dates and numbers in the format the user chose in Kept's preferences (a BCP 47 tag such as "de-CH").
struct Formats: Sendable, Equatable {
    let locale: Locale
    /// Hide amounts behind dots ("blur amounts" in Kept's preferences).
    var hideAmounts = false

    init(localeTag: String = "en-GB", hideAmounts: Bool = false) {
        locale = Locale(identifier: localeTag)
        self.hideAmounts = hideAmounts
    }

    private static let zeroDecimals: Set<String> = [
        "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
    ]
    private static let threeDecimals: Set<String> = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]

    /// Number of minor-unit digits of an ISO 4217 currency (CHF 2, JPY 0, KWD 3).
    static func exponent(_ currency: String) -> Int {
        let code = currency.uppercased()
        if zeroDecimals.contains(code) { return 0 }
        if threeDecimals.contains(code) { return 3 }
        return 2
    }

    /// "CHF 1’234.50" for 123450 minor units. Shows the amount even when amounts are hidden; use `AmountText` in views.
    func money(_ minor: Int64, _ currency: String, showPlus: Bool = false) -> String {
        let exponent = Self.exponent(currency)
        let value = Decimal(minor) / pow(10, exponent)
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .currency
        formatter.currencyCode = currency.uppercased()
        formatter.minimumFractionDigits = exponent
        formatter.maximumFractionDigits = exponent
        let text = formatter.string(from: value as NSDecimalNumber) ?? "\(currency) \(value)"
        return (showPlus && minor > 0 ? "+" : "") + text
    }

    /// "1234.50" for 123450: what an amount field of a form is filled with, and what the server parses.
    static func amountInput(_ minor: Int64, _ currency: String) -> String {
        let exponent = Self.exponent(currency)
        let negative = minor < 0
        var digits = String(minor.magnitude)
        while digits.count < exponent + 1 { digits = "0" + digits }
        let whole = digits.dropLast(exponent)
        let fraction = digits.suffix(exponent)
        return (negative ? "-" : "") + whole + (exponent > 0 ? "." + fraction : "")
    }

    /// A plain number with up to `maxDecimals` decimals (quantities, prices).
    func number(_ value: Double, maxDecimals: Int = 2, minDecimals: Int = 0) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = minDecimals
        formatter.maximumFractionDigits = maxDecimals
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    func percent(_ fraction: Double, decimals: Int = 1) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .percent
        formatter.minimumFractionDigits = decimals
        formatter.maximumFractionDigits = decimals
        return formatter.string(from: NSNumber(value: fraction)) ?? "\(fraction * 100)%"
    }

    /// The calendar date of "2026-03-12" (or the date part of a longer string), at noon UTC.
    static func parseDate(_ iso: String?) -> Date? {
        guard let iso, iso.count >= 10 else { return nil }
        let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar.date(from: components)
    }

    /// "2026-03-12" for a date picked in the device's calendar.
    static func isoDate(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    /// The `Date` a date picker shows for "2026-03-12" in the device's calendar.
    static func pickerDate(_ iso: String?) -> Date? {
        guard let iso, iso.count >= 10 else { return nil }
        let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    private func dateFormatter(_ style: DateFormatter.Style) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateStyle = style
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }

    /// "12 Mar 2026" for "2026-03-12"; the input unchanged when it is not a date.
    func date(_ iso: String?) -> String {
        guard let date = Self.parseDate(iso) else { return iso ?? "" }
        return dateFormatter(.medium).string(from: date)
    }

    /// "12.03.26": for tight rows.
    func shortDate(_ iso: String?) -> String {
        guard let date = Self.parseDate(iso) else { return iso ?? "" }
        return dateFormatter(.short).string(from: date)
    }

    /// "March 2026" for "2026-03".
    func month(_ isoMonth: String?) -> String {
        guard let isoMonth, let date = Self.parseDate(isoMonth + "-01") else { return isoMonth ?? "" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.setLocalizedDateFormatFromTemplate("MMMMyyyy")
        return formatter.string(from: date)
    }

    /// The date of an ISO 8601 instant ("2026-03-12T08:15:00.000Z") in the device's zone.
    func instant(_ iso: String?) -> String {
        guard let iso else { return "" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) ?? plain.date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}

private struct FormatsKey: EnvironmentKey {
    static let defaultValue = Formats()
}

private struct SessionKey: EnvironmentKey {
    static let defaultValue: SessionDetails? = nil
}

extension EnvironmentValues {
    /// Formatting for the signed-in user's locale: `@Environment(\.formats) private var formats`.
    var formats: Formats {
        get { self[FormatsKey.self] }
        set { self[FormatsKey.self] = newValue }
    }

    /// Who is signed in, their preferences and the server's "today"; nil until the first answer arrived.
    var session: SessionDetails? {
        get { self[SessionKey.self] }
        set { self[SessionKey.self] = newValue }
    }
}
