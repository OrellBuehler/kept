import Foundation

/// `GET pages/investments`. Amounts are minor units; quantities and prices are fixed-point
/// integers scaled by 10^8 (150_000_000 is 1.5).
struct InvestmentsPage: Decodable, Sendable {
    let overview: Overview
    let securities: [Security]
    let marketData: MarketData
    /// Present when the page was loaded with `prices=<security id>`.
    let priceHistory: PriceHistory?

    struct Overview: Decodable, Sendable {
        let totals: [Total]
        let securities: [Group]
    }

    struct Total: Decodable, Sendable, Identifiable {
        let currency: String
        let value: Int64
        let cost: Int64
        let gain: Int64
        let estimated: Bool
        var id: String { currency }
    }

    struct Group: Decodable, Sendable, Identifiable {
        let securityId: String
        let name: String
        let currency: String
        let quantity: Int64
        let price: Int64
        let priceDate: String
        let priceSource: String
        let totals: [Total]
        let positions: [Position]
        var id: String { securityId }
    }

    struct Position: Decodable, Sendable, Identifiable {
        let securityId: String
        let quantity: Int64
        let fxRate: Int64?
        let value: Int64
        let cost: Int64
        let gain: Int64
        let estimated: Bool
        let accountId: String
        let accountName: String
        let institutionName: String?
        let accountCurrency: String
        var id: String { accountId }
    }

    struct Security: Decodable, Sendable, Identifiable, Hashable {
        let id: String
        let name: String
        let kind: String
        let isin: String?
        let symbol: String?
        let currency: String
    }

    struct MarketData: Decodable, Sendable {
        let enabled: Bool
        let canLookup: Bool
    }

    struct PriceHistory: Decodable, Sendable {
        let security: Security
        let prices: [Price]
        let total: Int
    }

    struct Price: Decodable, Sendable, Identifiable {
        let id: String
        let securityId: String
        let date: String
        let price: Int64
        let source: String
    }
}

/// What the `lookup` action answers: matches of the market data provider.
struct InvestmentsLookupResult: Decodable, Sendable {
    let matches: [Match]

    struct Match: Decodable, Sendable, Identifiable {
        let symbol: String
        let name: String
        let currency: String?
        let kind: String?
        let isin: String?
        var id: String { symbol }
    }
}

/// Labels and fixed-point helpers of the investments screens.
enum InvestmentsText {
    static let kinds: [String] = ["etf", "stock", "fund", "bond", "other"]

    nonisolated static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "etf": return "ETF"
        case "stock": return "Stock"
        case "fund": return "Fund"
        case "bond": return "Bond"
        case "other": return "Other"
        default: return kind
        }
    }

    /// Where a price comes from; "trade" is the fallback to the last trade price.
    nonisolated static func sourceLabel(_ source: String) -> String {
        switch source {
        case "manual": return "manual"
        case "provider": return "fetched"
        case "trade": return "last trade"
        default: return source
        }
    }

    /// The sign, whole part and the 8 fraction digits of a fixed-point value.
    nonisolated static func parts(_ value: Int64) -> (negative: Bool, whole: UInt64, fraction: String) {
        let scale: UInt64 = 100_000_000
        let magnitude = value.magnitude
        let whole = magnitude / scale
        let rest = magnitude % scale
        var fraction = String(rest)
        while fraction.count < 8 { fraction = "0" + fraction }
        return (value < 0, whole, fraction)
    }

    /// "1.5" for 150_000_000: a plain decimal for form fields (round-trips with the server's parser).
    nonisolated static func input(_ value: Int64) -> String {
        let split = parts(value)
        var fraction = split.fraction
        while fraction.hasSuffix("0") { fraction.removeLast() }
        let sign = split.negative ? "-" : ""
        if fraction.isEmpty { return sign + String(split.whole) }
        return sign + String(split.whole) + "." + fraction
    }

    /// Display text with grouping, at least `minFraction` and at most 8 decimals.
    nonisolated static func format(_ value: Int64, locale: Locale, minFraction: Int = 0) -> String {
        let split = parts(value)
        var fraction = split.fraction
        while fraction.hasSuffix("0") { fraction.removeLast() }
        while fraction.count < minFraction { fraction += "0" }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.maximumFractionDigits = 0
        let whole = formatter.string(from: NSNumber(value: split.whole)) ?? String(split.whole)
        let sign = split.negative ? "-" : ""
        if fraction.isEmpty { return sign + whole }
        let separator: String = formatter.decimalSeparator ?? "."
        return sign + whole + separator + fraction
    }
}
