package ch.orellbuehler.kept.ui.accounts

import ch.orellbuehler.kept.model.AccountDetailTrade
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class Fixed8Test {
    @Test
    fun parsesDecimalsAndSeparators() {
        assertEquals(150_000_000L, Fixed8.parse("1.5"))
        assertEquals(150_000_000L, Fixed8.parse("1,5"))
        assertEquals(123_450_000_000L, Fixed8.parse("1'234,5"))
        assertEquals(123_450_000_000L, Fixed8.parse(" 1 234.5 "))
        assertEquals(1L, Fixed8.parse("0.00000001"))
        assertEquals(1_000_000_000L, Fixed8.parse("+10"))
        assertEquals(-250_000_000L, Fixed8.parse("-2.5"))
        assertEquals(0L, Fixed8.parse("-0"))
    }

    @Test
    fun refusesWhatIsNotANumber() {
        assertNull(Fixed8.parse(""))
        assertNull(Fixed8.parse("abc"))
        assertNull(Fixed8.parse("1.2.3"))
        assertNull(Fixed8.parse("0.000000001"))
        assertNull(Fixed8.parse("100000000.00000000"))
    }

    @Test
    fun writesPlainDecimalsThatParseBack() {
        assertEquals("1.5", Fixed8.toInput(150_000_000))
        assertEquals("2", Fixed8.toInput(200_000_000))
        assertEquals("0.00000001", Fixed8.toInput(1))
        assertEquals("-0.5", Fixed8.toInput(-50_000_000))
        assertEquals("0", Fixed8.toInput(0))
        listOf(1L, 150_000_000L, 123_456_789_012L, -99_999_999L).forEach { assertEquals(it, Fixed8.parse(Fixed8.toInput(it))) }
    }

    @Test
    fun formatsForTheLocale() {
        assertEquals("1,234.5", Fixed8.format(123_450_000_000, Locale.UK))
        assertEquals("1,234.50", Fixed8.format(123_450_000_000, Locale.UK, minFraction = 2))
        assertEquals("1.234,5", Fixed8.format(123_450_000_000, Locale.GERMANY))
        assertEquals("-3", Fixed8.format(-300_000_000, Locale.UK))
        assertEquals("0.00000001", Fixed8.format(1, Locale.UK))
    }

    @Test
    fun valuesAQuantityAtAPrice() {
        val scale = Fixed8.SCALE
        assertEquals(1_500L, Fixed8.valueOf(150_000_000, 1_000_000_000, scale, "CHF"))
        assertEquals(124L, Fixed8.valueOf(3 * scale, 41_166_667, scale, "CHF"))
        assertEquals(-1_500L, Fixed8.valueOf(-150_000_000, 1_000_000_000, scale, "CHF"))
        assertEquals(10L, Fixed8.valueOf(scale, 10 * scale, scale, "JPY"))
        assertEquals(1_500L, Fixed8.valueOf(150_000_000, 500_000_000, 2 * scale, "CHF"))
    }

    private fun trade(
        quantity: Long,
        new: Long? = null,
        old: Long? = null,
    ) = AccountDetailTrade(id = "t", side = "split", quantity = quantity, splitNew = new, splitOld = old)

    @Test
    fun readsTheTermsOfASplit() {
        assertEquals(3L to 2L, Fixed8.splitTerms(trade(150_000_000, 3, 2)))
        assertEquals(2L to 1L, Fixed8.splitTerms(trade(200_000_000)))
        assertEquals(1L to 10L, Fixed8.splitTerms(trade(10_000_000)))
        assertNull(Fixed8.splitTerms(trade(150_000_000)))
    }
}
