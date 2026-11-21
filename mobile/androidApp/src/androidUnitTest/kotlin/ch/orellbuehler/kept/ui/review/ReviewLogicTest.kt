package ch.orellbuehler.kept.ui.review

import ch.orellbuehler.kept.model.ReviewMonth
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReviewLogicTest {
    @Test
    fun barsAreScaledToTheTallestAndNeverInvisible() {
        val bars = monthBars(listOf(ReviewMonth("2026-01", 1000, 500), ReviewMonth("2026-02", 0, 1), ReviewMonth("2026-03", 0, 0)))
        assertEquals(1f, bars[0].income)
        assertEquals(0.5f, bars[0].expenses)
        assertEquals(0f, bars[1].income)
        assertEquals(0.02f, bars[1].expenses)
        assertEquals(0f, bars[2].expenses)
    }

    @Test
    fun noMonthsMeansNoBars() {
        assertTrue(monthBars(emptyList()).isEmpty())
        assertEquals(0f, monthBars(listOf(ReviewMonth("2026-01", 0, 0)))[0].income)
    }

    @Test
    fun monthInitialUsesTheLocale() {
        assertEquals("J", monthInitial("2026-01", Locale.ENGLISH))
        assertEquals("M", monthInitial("2026-03", Locale.GERMAN))
        assertEquals("nope", monthInitial("nope", Locale.ENGLISH))
    }

    @Test
    fun yearStepsStayWithinTheYearsOfTheData() {
        assertFalse(canStep(2024, -1, 2024, 2026))
        assertTrue(canStep(2025, -1, 2024, 2026))
        assertTrue(canStep(2025, 1, 2024, 2026))
        assertFalse(canStep(2026, 1, 2024, 2026))
    }

    @Test
    fun shareIsAFractionOfTheTotal() {
        assertEquals(0.25f, share(25, 100))
        assertEquals(1f, share(200, 100))
        assertEquals(0f, share(5, 0))
        assertEquals(0f, share(-5, 100))
    }
}
