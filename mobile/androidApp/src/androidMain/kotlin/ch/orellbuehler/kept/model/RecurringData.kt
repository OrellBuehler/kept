package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/recurring`. Amounts are minor units; payments are negative, income is positive. */
@Serializable
data class RecurringPage(
    val series: List<RecurringSeries> = emptyList(),
    val totals: List<RecurringTotal> = emptyList(),
)

@Serializable
data class RecurringSeries(
    val id: String,
    /** "suggested", "confirmed" or "dismissed". */
    val status: String = "suggested",
    val name: String = "",
    /** "weekly", "monthly", "quarterly" or "yearly". */
    val cadence: String = "monthly",
    val currency: String = "",
    val amount: Long = 0,
    val annualCost: Long = 0,
    val monthlyCost: Long = 0,
    val firstDate: String = "",
    val lastDate: String = "",
    val lastAmount: Long = 0,
    val occurrences: Int = 0,
    val nextExpected: String = "",
    val overdue: Boolean = false,
    val priceChange: RecurringPriceChange? = null,
)

@Serializable
data class RecurringPriceChange(
    val previous: Long = 0,
    val latest: Long = 0,
    val delta: Long = 0,
)

@Serializable
data class RecurringTotal(
    val currency: String,
    val outflowMonthly: Long = 0,
    val outflowAnnual: Long = 0,
    val inflowMonthly: Long = 0,
    val inflowAnnual: Long = 0,
)
