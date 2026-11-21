package ch.orellbuehler.kept

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AmountsTest {
    @Test
    fun writesMinorUnitsAsFormInput() {
        assertEquals("1234.50", Amounts.toInput(123450, "CHF"))
        assertEquals("-0.05", Amounts.toInput(-5, "EUR"))
        assertEquals("0.00", Amounts.toInput(0, "CHF"))
        assertEquals("500", Amounts.toInput(500, "JPY"))
        assertEquals("1.500", Amounts.toInput(1500, "KWD"))
    }

    @Test
    fun parsesWhatPeopleType() {
        assertEquals(123450, Amounts.parse("1'234.50", "CHF"))
        assertEquals(123450, Amounts.parse(" 1 234,5 ", "CHF"))
        assertEquals(-1200, Amounts.parse("-12", "EUR"))
        assertEquals(500, Amounts.parse("500", "JPY"))
        assertNull(Amounts.parse("12.345", "CHF"))
        assertNull(Amounts.parse("1.5", "JPY"))
        assertNull(Amounts.parse("abc", "CHF"))
        assertNull(Amounts.parse("", "CHF"))
    }
}
