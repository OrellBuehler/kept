package ch.orellbuehler.kept.ui.forecast

import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.model.ForecastAccount
import ch.orellbuehler.kept.model.ForecastPoint
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * The balances of [points] for every calendar day from the first to the last point, the balance
 * of the previous point carried over days that have none. The chart needs evenly spaced values.
 */
fun dailyBalances(points: List<ForecastPoint>): List<Long> {
    val dated =
        points
            .mapNotNull { point -> runCatching { LocalDate.parse(point.date.take(10)) }.getOrNull()?.let { it to point.balance } }
            .sortedBy { it.first }
    if (dated.isEmpty()) return emptyList()
    val first = dated.first().first
    val days = ChronoUnit.DAYS.between(first, dated.last().first).toInt()
    val out = ArrayList<Long>(days + 1)
    var index = 0
    var current = dated.first().second
    for (offset in 0..days) {
        val date = first.plusDays(offset.toLong())
        while (index < dated.size && !dated[index].first.isAfter(date)) {
            current = dated[index].second
            index++
        }
        out += current
    }
    return out
}

/** The accounts whose projection warns, in the order of the page. */
fun warnings(accounts: List<ForecastAccount>): List<ForecastAccount> = accounts.filter { it.warning != null }

/** Planned items are signed: negative is an expense. */
fun plannedDirection(amount: Long): String = if (amount > 0) "income" else "expense"

fun plannedFields(
    id: String?,
    label: String,
    date: String,
    direction: String,
    amount: String,
    accountId: String,
    currency: String,
): Map<String, String?> =
    linkedMapOf(
        "id" to id,
        "label" to label.trim(),
        "date" to date,
        "direction" to direction,
        "amount" to amount.trim(),
        "accountId" to accountId,
        // The web disables the currency field when an account is chosen, so it is not sent then.
        "currency" to if (accountId.isEmpty()) currency.trim().uppercase() else null,
    )

fun settingsFields(
    accountId: String,
    threshold: String,
    defaultPayment: Boolean,
): Map<String, String?> =
    linkedMapOf(
        "accountId" to accountId,
        "threshold" to threshold.trim(),
        "defaultPayment" to if (defaultPayment) "on" else null,
    )

fun Map<String, String?>.toFormBody(): FormBody = FormBody().also { form -> forEach { (name, value) -> form.set(name, value) } }
