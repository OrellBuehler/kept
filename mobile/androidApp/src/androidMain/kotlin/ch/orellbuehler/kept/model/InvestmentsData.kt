package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/investments`: the portfolio, the securities and, when a price history is asked for, that history. */
@Serializable
data class InvestmentsPage(
    val overview: InvestmentsOverview = InvestmentsOverview(),
    val securities: List<SecurityItem> = emptyList(),
    val marketData: InvestmentsMarketData = InvestmentsMarketData(),
    val priceHistory: PriceHistory? = null,
)

@Serializable
data class InvestmentsOverview(
    val totals: List<InvestmentTotal> = emptyList(),
    val securities: List<InvestmentGroup> = emptyList(),
)

/** Value, cost and gain of holdings in one currency, in minor units of [currency]. */
@Serializable
data class InvestmentTotal(
    val currency: String = "",
    val value: Long = 0,
    val cost: Long = 0,
    val gain: Long = 0,
    /** Some positions are valued at cost because an exchange rate is missing. */
    val estimated: Boolean = false,
)

/** One security with everything held in it. [quantity] and [price] are fixed-point integers scaled by 1e8. */
@Serializable
data class InvestmentGroup(
    val securityId: String,
    val name: String = "",
    val currency: String = "",
    val quantity: Long = 0,
    val price: Long = 0,
    val priceDate: String = "",
    /** "manual", "provider" or "trade" (the last trade price, when there is no quote). */
    val priceSource: String = "manual",
    val totals: List<InvestmentTotal> = emptyList(),
    val positions: List<InvestmentPosition> = emptyList(),
)

/** The holding of one security in one account; amounts are in [accountCurrency]. */
@Serializable
data class InvestmentPosition(
    val securityId: String = "",
    val quantity: Long = 0,
    val value: Long = 0,
    val cost: Long = 0,
    val gain: Long = 0,
    val estimated: Boolean = false,
    val accountId: String = "",
    val accountName: String = "",
    val institutionName: String? = null,
    val accountCurrency: String = "",
)

@Serializable
data class SecurityItem(
    val id: String,
    val name: String = "",
    /** "etf", "stock", "fund", "bond" or "other". */
    val kind: String = "other",
    val isin: String? = null,
    val symbol: String? = null,
    val currency: String = "",
)

@Serializable
data class InvestmentsMarketData(
    val enabled: Boolean = false,
    val canLookup: Boolean = false,
)

@Serializable
data class PriceHistory(
    val security: SecurityItem,
    val prices: List<PricePoint> = emptyList(),
    val total: Int = 0,
)

/** A price of a security on a day: [price] is scaled by 1e8, [source] is "manual" or "provider". */
@Serializable
data class PricePoint(
    val id: String,
    val securityId: String = "",
    val date: String = "",
    val price: Long = 0,
    val source: String = "manual",
)

/** What the `lookup` action answers. */
@Serializable
data class SecurityLookupResult(
    val matches: List<SecurityMatch> = emptyList(),
)

@Serializable
data class SecurityMatch(
    val symbol: String = "",
    val name: String = "",
    val currency: String? = null,
    val kind: String? = null,
    val isin: String? = null,
)
