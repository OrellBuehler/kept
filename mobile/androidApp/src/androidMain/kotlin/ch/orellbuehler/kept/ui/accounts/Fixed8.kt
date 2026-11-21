package ch.orellbuehler.kept.ui.accounts

import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.model.AccountDetailTrade
import java.math.BigInteger
import java.text.DecimalFormatSymbols
import java.text.NumberFormat
import java.util.Locale

/**
 * Quantities, unit prices and rates: integers scaled by 10^8, so 1.5 is 150000000. The same
 * arithmetic as the web's `$lib/quantity`, in integers only.
 */
object Fixed8 {
    const val SCALE = 100_000_000L
    const val DECIMALS = 8

    /** The web's `Number.MAX_SAFE_INTEGER`: larger values are refused there, so they are here. */
    private const val MAX_SAFE = 9_007_199_254_740_991L

    private val number = Regex("^([+-])?(\\d+)(?:[.,](\\d+))?$")

    /** "12.5", "1'234,5", "0.00000001" (at most 8 decimals) as a scaled integer; null when it is not a number. */
    fun parse(input: String): Long? {
        val cleaned = input.trim().filterNot { it.isWhitespace() || it == '\'' || it == '’' }
        val match = number.find(cleaned) ?: return null
        val (sign, whole, fraction) = match.destructured
        if (fraction.length > DECIMALS) return null
        val scaled = BigInteger(whole).multiply(BigInteger.valueOf(SCALE)).add(BigInteger(fraction.padEnd(DECIMALS, '0')))
        if (scaled > BigInteger.valueOf(MAX_SAFE)) return null
        val value = scaled.toLong()
        return if (sign == "-") -value else value
    }

    /** Plain decimal for a form field: 150000000 is "1.5" (parses back to the same value). */
    fun toInput(value: Long): String {
        val (negative, whole, fraction) = split(value)
        val trimmed = fraction.trimEnd('0')
        return (if (negative) "-" else "") + whole + (if (trimmed.isEmpty()) "" else ".$trimmed")
    }

    /** Display text with grouping in the user's locale, at least [minFraction] and at most 8 decimals. */
    fun format(
        value: Long,
        locale: Locale,
        minFraction: Int = 0,
    ): String {
        val (negative, whole, fraction) = split(value)
        val trimmed = fraction.trimEnd('0').padEnd(minFraction, '0')
        val decimal = DecimalFormatSymbols.getInstance(locale).decimalSeparator
        val grouped = NumberFormat.getIntegerInstance(locale).format(whole)
        return (if (negative) "-" else "") + grouped + (if (trimmed.isEmpty()) "" else "$decimal$trimmed")
    }

    /** `quantity * price * fx` in minor units of [currency], rounded half away from zero (`fx` is 10^8 for no conversion). */
    fun valueOf(
        quantity: Long,
        price: Long,
        fx: Long,
        currency: String,
    ): Long {
        val scale = BigInteger.TEN.pow(Amounts.exponent(currency))
        val scaleBig = BigInteger.valueOf(SCALE)
        val product =
            BigInteger
                .valueOf(quantity)
                .abs()
                .multiply(BigInteger.valueOf(price).abs())
                .multiply(BigInteger.valueOf(fx).abs())
                .multiply(scale)
        val denominator = scaleBig.pow(3)
        val rounded = product.add(denominator.shiftRight(1)).divide(denominator).toLong()
        val negative = (quantity < 0 != price < 0) != fx < 0
        return if (negative && rounded != 0L) -rounded else rounded
    }

    /** The `new : old` terms of a split, or null when the ratio is not a whole one (the web's `splitTerms`). */
    fun splitTerms(trade: AccountDetailTrade): Pair<Long, Long>? {
        val new = trade.splitNew
        val old = trade.splitOld
        if (new != null && old != null && new != 0L && old != 0L) return new to old
        val quantity = trade.quantity
        if (quantity >= SCALE && quantity % SCALE == 0L) return quantity / SCALE to 1L
        if (quantity > 0 && SCALE % quantity == 0L) return 1L to SCALE / quantity
        return null
    }

    private fun split(value: Long): Triple<Boolean, Long, String> {
        val abs = BigInteger.valueOf(value).abs()
        val parts = abs.divideAndRemainder(BigInteger.valueOf(SCALE))
        return Triple(value < 0, parts[0].toLong(), parts[1].toString().padStart(DECIMALS, '0'))
    }
}
