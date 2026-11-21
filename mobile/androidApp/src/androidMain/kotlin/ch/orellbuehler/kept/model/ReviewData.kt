package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/review?year=YYYY`. Amounts are minor units of the currency of their section. */
@Serializable
data class ReviewPage(
    val year: Int = 0,
    val currentYear: Int = 0,
    val firstYear: Int = 0,
    val review: YearReview = YearReview(),
)

@Serializable
data class YearReview(
    val year: Int = 0,
    val from: String = "",
    val to: String = "",
    /** True while the year is not over: the review counts up to [to]. */
    val partial: Boolean = false,
    val excludedTransfers: Int = 0,
    val currencies: List<ReviewCurrency> = emptyList(),
)

@Serializable
data class ReviewCurrency(
    val currency: String,
    val income: Long = 0,
    val expenses: Long = 0,
    val net: Long = 0,
    /** Net divided by income; null without income. */
    val savingsRate: Double? = null,
    val netWorth: ReviewNetWorth? = null,
    val hasPreviousYear: Boolean = false,
    val sankey: ReviewFlow = ReviewFlow(),
    val changes: List<ReviewChange> = emptyList(),
    val counterparties: List<ReviewCounterparty> = emptyList(),
    val largestExpenses: List<ReviewTransaction> = emptyList(),
    val largestIncome: List<ReviewTransaction> = emptyList(),
    val months: List<ReviewMonth> = emptyList(),
)

@Serializable
data class ReviewNetWorth(
    val start: Long = 0,
    val end: Long = 0,
    val change: Long = 0,
)

/** The money flow the web draws as a Sankey diagram: incomes on the left, expenses and savings on the right. */
@Serializable
data class ReviewFlow(
    val left: List<ReviewFlowNode> = emptyList(),
    val right: List<ReviewFlowNode> = emptyList(),
)

@Serializable
data class ReviewFlowNode(
    val id: String = "",
    val label: String = "",
    val value: Long = 0,
    val color: String? = null,
    /** "income", "expense", "uncategorized" or "saved". */
    val kind: String = "",
)

@Serializable
data class ReviewChange(
    val categoryId: String? = null,
    val name: String = "",
    val color: String? = null,
    /** "income" or "expense". */
    val side: String = "expense",
    val amount: Long = 0,
    val previous: Long = 0,
    val change: Long = 0,
    /** Null when there was nothing in the previous year ("new"). */
    val changePct: Double? = null,
)

@Serializable
data class ReviewCounterparty(
    val name: String = "",
    val spent: Long = 0,
    val count: Int = 0,
)

@Serializable
data class ReviewTransaction(
    val id: String,
    val bookingDate: String = "",
    val amount: Long = 0,
    val counterparty: String? = null,
    val categoryName: String? = null,
)

@Serializable
data class ReviewMonth(
    val month: String = "",
    val income: Long = 0,
    val expenses: Long = 0,
)
