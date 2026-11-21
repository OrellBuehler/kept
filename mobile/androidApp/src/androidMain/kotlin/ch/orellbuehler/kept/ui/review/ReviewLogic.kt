package ch.orellbuehler.kept.ui.review

import ch.orellbuehler.kept.model.ReviewMonth
import java.time.Month
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale

/** Income and expense bar heights of one month as a fraction (0..1) of the tallest bar; a bar that exists is at least 2% high. */
data class MonthBar(
    val month: String,
    val income: Float,
    val expenses: Float,
)

fun monthBars(months: List<ReviewMonth>): List<MonthBar> {
    val max = months.maxOfOrNull { maxOf(it.income, it.expenses) }?.takeIf { it > 0 } ?: 1L

    fun height(value: Long): Float = if (value <= 0) 0f else (value.toFloat() / max).coerceIn(0.02f, 1f)
    return months.map { MonthBar(it.month, height(it.income), height(it.expenses)) }
}

/** The one-letter label of "2026-03" in [locale]; the input when it is not a month. */
fun monthInitial(
    isoMonth: String,
    locale: Locale,
): String =
    try {
        val month: Month = YearMonth.parse(isoMonth).month
        month.getDisplayName(TextStyle.NARROW, locale)
    } catch (e: java.time.format.DateTimeParseException) {
        isoMonth
    }

/** Whether the year picker may move by [step] years within [first]..[current]. */
fun canStep(
    year: Int,
    step: Int,
    first: Int,
    current: Int,
): Boolean {
    val target = year + step
    return target in minOf(first, year)..maxOf(current, year) && target != year
}

/** The share of [value] in [total] as a 0..1 fraction for a bar; 0 when there is no total. */
fun share(
    value: Long,
    total: Long,
): Float = if (total <= 0 || value <= 0) 0f else (value.toFloat() / total).coerceIn(0f, 1f)
