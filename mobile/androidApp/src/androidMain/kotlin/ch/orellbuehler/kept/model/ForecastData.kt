package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/forecast?days=30|60|90`. Amounts are minor units of the currency next to them. */
@Serializable
data class ForecastPage(
    val today: String = "",
    val days: Int = 30,
    val horizons: List<Int> = listOf(30, 60, 90),
    val forecast: Forecast = Forecast(),
    val planned: List<ForecastPlanned> = emptyList(),
    val settings: List<ForecastAccountSettings> = emptyList(),
)

@Serializable
data class Forecast(
    val from: String = "",
    val to: String = "",
    val days: Int = 30,
    val accounts: List<ForecastAccount> = emptyList(),
    val items: List<ForecastItem> = emptyList(),
    /** Items of a currency that no account takes. */
    val unassigned: List<ForecastUnassigned> = emptyList(),
    val today: String = "",
    val unprojectedBills: ForecastUnprojected = ForecastUnprojected(),
)

@Serializable
data class ForecastAccount(
    val accountId: String,
    val name: String = "",
    val currency: String = "",
    val hasBalance: Boolean = false,
    val startBalance: Long = 0,
    val endBalance: Long = 0,
    val threshold: Long? = null,
    val points: List<ForecastPoint> = emptyList(),
    val lowest: ForecastPoint = ForecastPoint(),
    val warning: ForecastWarning? = null,
    val negativeDate: String? = null,
)

@Serializable
data class ForecastPoint(
    val date: String = "",
    val balance: Long = 0,
)

@Serializable
data class ForecastWarning(
    val date: String = "",
    val balance: Long = 0,
    val limit: Long = 0,
    val negative: Boolean = false,
)

@Serializable
data class ForecastItem(
    val date: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val accountId: String? = null,
    /** "bill" or "planned". */
    val source: String = "",
    val label: String = "",
    val ref: String? = null,
)

@Serializable
data class ForecastUnassigned(
    val currency: String,
    val inflow: Long = 0,
    val outflow: Long = 0,
    val count: Int = 0,
)

@Serializable
data class ForecastUnprojected(
    val noDueDate: Int = 0,
    val noAmount: Int = 0,
)

/** A one-off item the user planned; the amount is signed (negative is an expense). */
@Serializable
data class ForecastPlanned(
    val id: String,
    val accountId: String? = null,
    val date: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val label: String = "",
)

@Serializable
data class ForecastAccountSettings(
    val accountId: String,
    val threshold: Long? = null,
    val defaultPayment: Boolean = false,
)
