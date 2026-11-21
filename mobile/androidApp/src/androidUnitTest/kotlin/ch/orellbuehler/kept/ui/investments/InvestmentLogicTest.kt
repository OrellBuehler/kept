package ch.orellbuehler.kept.ui.investments

import ch.orellbuehler.kept.model.SecurityItem
import ch.orellbuehler.kept.model.SecurityMatch
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class InvestmentLogicTest {
    private val en = Locale.forLanguageTag("en-GB")
    private val de = Locale.forLanguageTag("de-CH")

    @Test
    fun formatsFixedPointWithoutFloats() {
        assertEquals("20", formatFixed(2_000_000_000, en))
        assertEquals("1.5", formatFixed(150_000_000, en))
        assertEquals("0.00000001", formatFixed(1, en))
        assertEquals("54.00", formatFixed(5_400_000_000, en, 2))
        assertEquals("1,234.5", formatFixed(123_450_000_000, en))
        assertEquals("0.00", formatFixed(0, en, 2))
    }

    @Test
    fun formatsNegativeAndKeepsDigitsBeyondTwoDecimals() {
        assertEquals("-1.25", formatFixed(-125_000_000, en))
        assertEquals("12.3456", formatFixed(1_234_560_000, en, 2))
    }

    @Test
    fun usesTheLocalesSeparators() {
        val text = formatFixed(123_450_000_000, de, 2)
        assertTrue(text.endsWith("50"))
        assertTrue(text.contains(DecimalSeparator.of(de)))
    }

    @Test
    fun buildsTheSecurityFormFields() {
        val values = SecurityFormValues(name = " Example ETF ", kind = "etf", isin = "ex0000000013", symbol = "exwld", currency = "chf")
        val fields = values.fields().toMap()
        assertEquals("Example ETF", fields["name"])
        assertEquals("EX0000000013", fields["isin"])
        assertEquals("EXWLD", fields["symbol"])
        assertEquals("CHF", fields["currency"])
    }

    @Test
    fun prefillsFromTheSecurityOrTheDefaultCurrency() {
        assertEquals(SecurityFormValues(currency = "CHF"), SecurityFormValues.of(null, "CHF"))
        val item = SecurityItem("id", "Bond", "bond", null, "BND", "USD")
        val values = SecurityFormValues.of(item, "CHF")
        assertEquals("bond", values.kind)
        assertEquals("", values.isin)
        assertEquals("BND", values.symbol)
        assertEquals("USD", values.currency)
    }

    @Test
    fun appliesALookupMatch() {
        val base = SecurityFormValues(name = "x", kind = "stock", isin = "keep", currency = "CHF")
        val partial = base.withMatch(SecurityMatch(symbol = "ABC", name = "Example Corp"))
        assertEquals("Example Corp", partial.name)
        assertEquals("ABC", partial.symbol)
        assertEquals("stock", partial.kind)
        assertEquals("keep", partial.isin)
        assertEquals("CHF", partial.currency)
        val full = base.withMatch(SecurityMatch("ABC", "Example Corp", "USD", "fund", "EX0000000021"))
        assertEquals("fund", full.kind)
        assertEquals("EX0000000021", full.isin)
        assertEquals("USD", full.currency)
        assertEquals("stock", base.withMatch(SecurityMatch("A", "n", kind = "unknown")).kind)
    }

    @Test
    fun searchNeedsTwoCharacters() {
        assertFalse(canSearch(" a "))
        assertTrue(canSearch("ab"))
    }
}

private object DecimalSeparator {
    fun of(locale: Locale): String =
        java.text.DecimalFormatSymbols
            .getInstance(locale)
            .decimalSeparator
            .toString()
}
