package ch.orellbuehler.kept.ui.reports

import ch.orellbuehler.kept.model.ReportAccount
import java.time.LocalDate
import java.time.format.DateTimeParseException

/** A report the server builds, named by the path segment of `endpoints/reports/<kind>`. */
enum class ReportKind(
    val path: String,
) {
    STATEMENT("statement"),
    BILLS("bills"),
    NET_WORTH("net-worth"),
    TAX("tax"),
    TAX_DEDUCTIONS("tax-deductions"),
}

/** The first and last day of the month before [today], the web form's default period. */
fun lastFullMonth(today: String): Pair<String, String> {
    val date = parseDate(today) ?: LocalDate.now()
    val last = date.withDayOfMonth(1).minusMonths(1)
    return last.toString() to last.withDayOfMonth(last.lengthOfMonth()).toString()
}

private fun parseDate(value: String): LocalDate? =
    try {
        LocalDate.parse(value)
    } catch (e: DateTimeParseException) {
        null
    }

/** True when both dates are set and the start is after the end. */
fun rangeInvalid(
    from: String,
    to: String,
): Boolean = from.isNotBlank() && to.isNotBlank() && from > to

/** The accounts the picker offers: archived ones only when asked for. */
fun visibleAccounts(
    accounts: List<ReportAccount>,
    showArchived: Boolean,
): List<ReportAccount> = accounts.filter { showArchived || !it.archived }

/** Whether a statement can be requested: a listed account and a valid period. */
fun canDownloadStatement(
    accounts: List<ReportAccount>,
    accountId: String,
    from: String,
    to: String,
): Boolean = accounts.any { it.id == accountId } && parseDate(from) != null && parseDate(to) != null && !rangeInvalid(from, to)

/** A four-digit year the server accepts (1900..2200), or null. */
fun parseYear(text: String): Int? =
    text
        .trim()
        .takeIf { it.length == 4 && it.all(Char::isDigit) }
        ?.toInt()
        ?.takeIf { it in 1900..2200 }

fun statementQuery(
    accountId: String,
    from: String,
    to: String,
): Map<String, String> = mapOf("account" to accountId, "from" to from, "to" to to)

fun yearQuery(year: Int): Map<String, String> = mapOf("year" to year.toString())

/** Net worth counted in full by default; "share" counts shared accounts at the user's share. */
fun netWorthQuery(share: Boolean): Map<String, String> = if (share) mapOf("basis" to "share") else emptyMap()

/** An IBAN for display by the user's setting ("full", "masked", "hidden"); null when hidden or missing. */
fun ibanLabel(
    iban: String?,
    mode: String,
): String? {
    val normalized = iban?.filter { !it.isWhitespace() }?.uppercase()?.takeIf { it.isNotEmpty() } ?: return null
    val shown =
        when (mode) {
            "hidden" -> return null
            "masked" ->
                if (normalized.length < 12) {
                    "•".repeat(normalized.length)
                } else {
                    normalized.take(4) + "•".repeat(normalized.length - 8) + normalized.takeLast(4)
                }
            else -> normalized
        }
    return shown.chunked(4).joinToString(" ")
}

/** A file name safe to write to the cache directory; [fallback] when the server sent none. */
fun safeFileName(
    name: String?,
    fallback: String,
): String {
    val cleaned =
        name
            .orEmpty()
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .trim('.', '_')
    return if (cleaned.isEmpty()) fallback else cleaned
}
