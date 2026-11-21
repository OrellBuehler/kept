package ch.orellbuehler.kept

/** Helpers for amounts in minor units. Formatting for display is done by the platform's number formatter. */
object Amounts {
    private val zeroDecimals =
        setOf("BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF")
    private val threeDecimals = setOf("BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND")

    /** Number of minor-unit digits of an ISO 4217 currency (CHF 2, JPY 0, KWD 3). */
    fun exponent(currency: String): Int =
        when (currency.uppercase()) {
            in zeroDecimals -> 0
            in threeDecimals -> 3
            else -> 2
        }

    /** "1234.50" for 123450: what an amount field of a form is filled with, and what the server parses. */
    fun toInput(
        minor: Long,
        currency: String,
    ): String = toDecimalString(minor, exponent(currency))

    fun toDecimalString(
        minor: Long,
        decimals: Int,
    ): String {
        val negative = minor < 0
        val digits = (if (negative) -minor else minor).toString().padStart(decimals + 1, '0')
        val whole = digits.substring(0, digits.length - decimals)
        val fraction = digits.substring(digits.length - decimals)
        return (if (negative) "-" else "") + whole + (if (decimals > 0) ".$fraction" else "")
    }

    /** Parses what a user types ("1'234.50", "1 234,5", "-12") into minor units; null when it is not an amount. */
    fun parse(
        input: String,
        currency: String,
    ): Long? {
        val decimals = exponent(currency)
        val cleaned = input.trim().filterNot { it.isWhitespace() || it == '\'' || it == '’' }
        val match = Regex("^([+-])?(\\d+)(?:[.,](\\d+))?$").find(cleaned) ?: return null
        val (sign, whole, fraction) = match.destructured
        if (fraction.length > decimals || whole.length > 15) return null
        val value = (whole + fraction.padEnd(decimals, '0')).toLongOrNull() ?: return null
        return if (sign == "-") -value else value
    }
}
