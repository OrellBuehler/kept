package ch.orellbuehler.kept.data

import kotlinx.serialization.Serializable

/** `GET pages/dashboard` (the web's "/"). Amounts are minor units of the `currency` next to them. */
@Serializable
data class DashboardPage(
    val today: String = "",
    val forecastAlerts: List<ForecastAlert> = emptyList(),
    val needsAmount: List<NeedsAmount> = emptyList(),
    val dashboard: Dashboard = Dashboard(),
)

/** An account whose projected balance goes below zero on [date]. */
@Serializable
data class ForecastAlert(
    val accountId: String,
    val name: String = "",
    val currency: String = "",
    val date: String = "",
    val balance: Long = 0,
)

/** A transfer into another currency that still waits for the amount received. */
@Serializable
data class NeedsAmount(
    val transferId: String,
    val sourceAccountId: String = "",
    val sourceAccountName: String = "",
    val targetAccountName: String = "",
    val targetCurrency: String = "",
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val description: String? = null,
)

@Serializable
data class Dashboard(
    val range: String = "12m",
    val hasShared: Boolean = false,
    val netWorth: NetWorth = NetWorth(),
    val accounts: List<DashboardAccount> = emptyList(),
    val invested: List<Invested> = emptyList(),
    val month: MonthSummary = MonthSummary(),
    /** The month counted at the user's share of shared accounts; null when nothing is shared. */
    val shareMonth: MonthSummary? = null,
    val spending: Spending = Spending(),
    val bills: DashboardBills = DashboardBills(),
    val unmatched: Unmatched = Unmatched(),
    val staleAccounts: Int = 0,
)

@Serializable
data class NetWorth(
    val from: String = "",
    val to: String = "",
    val series: List<CurrencySeries> = emptyList(),
    /** Like [series] with shared accounts at the user's share; null when nothing is shared. */
    val shareSeries: List<CurrencySeries>? = null,
    val totals: List<NetWorthTotal> = emptyList(),
)

@Serializable
data class CurrencySeries(
    val currency: String,
    val points: List<SeriesPoint> = emptyList(),
)

@Serializable
data class SeriesPoint(
    val date: String,
    val amount: Long = 0,
)

@Serializable
data class NetWorthTotal(
    val currency: String,
    val balance: Long = 0,
    val shareBalance: Long = 0,
    val accountCount: Int = 0,
)

@Serializable
data class InstitutionRef(
    val id: String,
    val name: String = "",
    val color: String? = null,
    val logoVersion: String? = null,
)

@Serializable
data class DashboardAccount(
    val id: String,
    val name: String = "",
    val type: String = "",
    val currency: String = "",
    val institution: InstitutionRef? = null,
    val balance: Long = 0,
    val shareBps: Int = 10_000,
    val shareBalance: Long = 0,
    val lastBookingDate: String? = null,
    val stale: Boolean = false,
    val noData: Boolean = false,
    val staleDays: Int? = null,
)

@Serializable
data class Invested(
    val currency: String,
    val shareValue: Long = 0,
    val shareGain: Long = 0,
    val estimated: Boolean = false,
)

@Serializable
data class MonthSummary(
    val month: String = "",
    val previousMonth: String = "",
    val totals: List<MonthTotal> = emptyList(),
    val previousTotals: List<MonthTotal> = emptyList(),
)

@Serializable
data class MonthTotal(
    val currency: String,
    val income: Long = 0,
    val expenses: Long = 0,
    val net: Long = 0,
)

@Serializable
data class Spending(
    val month: String = "",
    val currencies: List<SpendingCurrency> = emptyList(),
    val uncategorizedCount: Int = 0,
)

@Serializable
data class SpendingCurrency(
    val currency: String,
    val total: Long = 0,
    val items: List<SpendingItem> = emptyList(),
)

@Serializable
data class SpendingItem(
    val categoryId: String? = null,
    val name: String = "",
    val color: String? = null,
    val spent: Long = 0,
)

@Serializable
data class DashboardBills(
    val overdue: BillBucket = BillBucket(),
    val dueSoon: BillBucket = BillBucket(),
    val awaitingRefund: BillBucket = BillBucket(),
    val upcoming: List<UpcomingBill> = emptyList(),
    val unmatchedSuggestions: Int = 0,
)

@Serializable
data class BillBucket(
    val count: Int = 0,
    val totals: List<CurrencyAmount> = emptyList(),
)

@Serializable
data class CurrencyAmount(
    val currency: String,
    val amount: Long = 0,
)

@Serializable
data class UpcomingBill(
    val id: String,
    val kind: String = "invoice",
    val creditorName: String? = null,
    val invoiceNumber: String? = null,
    val amount: Long? = null,
    val remaining: Long? = null,
    val currency: String = "",
    val dueDate: String? = null,
    val dueInDays: Int? = null,
)

@Serializable
data class Unmatched(
    val days: Int = 0,
    val count: Int = 0,
)
