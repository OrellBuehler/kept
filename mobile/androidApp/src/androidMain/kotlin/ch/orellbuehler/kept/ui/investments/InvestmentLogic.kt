package ch.orellbuehler.kept.ui.investments

import ch.orellbuehler.kept.model.SecurityItem
import ch.orellbuehler.kept.model.SecurityMatch
import java.text.DecimalFormatSymbols
import java.text.NumberFormat
import java.util.Locale

private const val FIXED_DECIMALS = 8
private const val FIXED_SCALE = 100_000_000L

/**
 * A quantity or price (integer scaled by 1e8) as text with grouping, at least [minFraction] and at most 8
 * decimals, in integer arithmetic like the web's `formatFixed`.
 */
fun formatFixed(
    value: Long,
    locale: Locale,
    minFraction: Int = 0,
): String {
    val negative = value < 0
    val abs = if (value == Long.MIN_VALUE) Long.MAX_VALUE else kotlin.math.abs(value)
    val whole = abs / FIXED_SCALE
    val fraction =
        (abs % FIXED_SCALE)
            .toString()
            .padStart(FIXED_DECIMALS, '0')
            .trimEnd('0')
            .padEnd(minFraction, '0')
    val grouped = NumberFormat.getIntegerInstance(locale).format(whole)
    val separator = DecimalFormatSymbols.getInstance(locale).decimalSeparator
    return (if (negative) "-" else "") + grouped + (if (fraction.isEmpty()) "" else "$separator$fraction")
}

val securityKinds = listOf("etf", "stock", "fund", "bond", "other")

/** The fields of the security form, as the strings the web form sends. */
data class SecurityFormValues(
    val name: String = "",
    val kind: String = "etf",
    val isin: String = "",
    val symbol: String = "",
    val currency: String = "",
) {
    fun fields(): List<Pair<String, String>> =
        listOf(
            "name" to name.trim(),
            "kind" to kind,
            "isin" to isin.trim().uppercase(),
            "symbol" to symbol.trim().uppercase(),
            "currency" to currency.trim().uppercase(),
        )

    /** Fills the form from a lookup result; what the match does not know stays as it is. */
    fun withMatch(match: SecurityMatch): SecurityFormValues =
        copy(
            name = match.name,
            symbol = match.symbol,
            kind = match.kind?.takeIf { it in securityKinds } ?: kind,
            isin = match.isin ?: isin,
            currency = match.currency ?: currency,
        )

    companion object {
        fun of(
            security: SecurityItem?,
            defaultCurrency: String,
        ): SecurityFormValues =
            if (security == null) {
                SecurityFormValues(currency = defaultCurrency)
            } else {
                SecurityFormValues(
                    name = security.name,
                    kind = security.kind.takeIf { it in securityKinds } ?: "other",
                    isin = security.isin.orEmpty(),
                    symbol = security.symbol.orEmpty(),
                    currency = security.currency,
                )
            }
    }
}

/** The web asks for at least two characters before it sends a lookup. */
fun canSearch(query: String): Boolean = query.trim().length >= 2
