package ch.orellbuehler.kept.ui.common

import ch.orellbuehler.kept.Amounts
import java.math.BigDecimal
import java.text.NumberFormat
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.format.FormatStyle
import java.util.Currency
import java.util.Locale

/** Amounts, dates and numbers in the format the user chose in Kept's preferences (a BCP 47 tag such as "de-CH"). */
class Formats(
    localeTag: String,
) {
    val locale: Locale = Locale.forLanguageTag(localeTag)

    private val mediumDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)
    private val shortDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale)
    private val monthYear = DateTimeFormatter.ofPattern("LLLL yyyy", locale)

    /** "CHF 1’234.50" for 123450 minor units. */
    fun money(
        minor: Long,
        currency: String,
    ): String {
        val exponent = Amounts.exponent(currency)
        val value = BigDecimal.valueOf(minor, exponent)
        val format = NumberFormat.getCurrencyInstance(locale)
        try {
            format.currency = Currency.getInstance(currency.uppercase())
        } catch (e: IllegalArgumentException) {
            return "${currency.uppercase()} ${plain(value, exponent)}"
        }
        format.minimumFractionDigits = exponent
        format.maximumFractionDigits = exponent
        return format.format(value)
    }

    /** Like [money] with an explicit plus for positive amounts, for changes and transactions. */
    fun signedMoney(
        minor: Long,
        currency: String,
    ): String = (if (minor > 0) "+" else "") + money(minor, currency)

    private fun plain(
        value: BigDecimal,
        decimals: Int,
    ): String {
        val format = NumberFormat.getNumberInstance(locale)
        format.minimumFractionDigits = decimals
        format.maximumFractionDigits = decimals
        return format.format(value)
    }

    /** A plain number with up to [maxDecimals] decimals (quantities, prices, percentages). */
    fun number(
        value: Double,
        maxDecimals: Int = 2,
        minDecimals: Int = 0,
    ): String {
        val format = NumberFormat.getNumberInstance(locale)
        format.minimumFractionDigits = minDecimals
        format.maximumFractionDigits = maxDecimals
        return format.format(value)
    }

    fun percent(
        fraction: Double,
        decimals: Int = 1,
    ): String {
        val format = NumberFormat.getPercentInstance(locale)
        format.minimumFractionDigits = decimals
        format.maximumFractionDigits = decimals
        return format.format(fraction)
    }

    /** "12 Mar 2026" for "2026-03-12"; the input unchanged when it is not a date. */
    fun date(iso: String?): String = parseDate(iso)?.format(mediumDate) ?: iso.orEmpty()

    /** "12.03.26": for tight rows. */
    fun shortDate(iso: String?): String = parseDate(iso)?.format(shortDate) ?: iso.orEmpty()

    /** "March 2026" for "2026-03". */
    fun month(isoMonth: String?): String =
        try {
            YearMonth.parse(isoMonth.orEmpty()).format(monthYear)
        } catch (e: DateTimeParseException) {
            isoMonth.orEmpty()
        }

    /** The date part of an ISO 8601 instant ("2026-03-12T08:15:00.000Z") in the device's zone. */
    fun instant(iso: String?): String =
        try {
            java.time.Instant
                .parse(iso.orEmpty())
                .atZone(java.time.ZoneId.systemDefault())
                .toLocalDate()
                .format(mediumDate)
        } catch (e: DateTimeParseException) {
            iso.orEmpty()
        }

    companion object {
        fun parseDate(iso: String?): LocalDate? =
            try {
                iso?.let { LocalDate.parse(it.take(10)) }
            } catch (e: DateTimeParseException) {
                null
            }
    }
}
