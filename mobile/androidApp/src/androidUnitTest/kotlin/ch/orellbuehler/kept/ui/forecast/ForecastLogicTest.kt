package ch.orellbuehler.kept.ui.forecast

import ch.orellbuehler.kept.model.ForecastAccount
import ch.orellbuehler.kept.model.ForecastPoint
import ch.orellbuehler.kept.model.ForecastWarning
import kotlin.test.Test
import kotlin.test.assertEquals

class ForecastLogicTest {
    @Test
    fun dailyBalancesKeepEvenSeries() {
        val points = listOf(ForecastPoint("2026-11-21", 10), ForecastPoint("2026-11-22", 20), ForecastPoint("2026-11-23", 5))
        assertEquals(listOf(10L, 20L, 5L), dailyBalances(points))
    }

    @Test
    fun dailyBalancesFillGapsWithThePreviousBalance() {
        val points = listOf(ForecastPoint("2026-11-30", 10), ForecastPoint("2026-12-03", 40), ForecastPoint("2026-12-04", 50))
        assertEquals(listOf(10L, 10L, 10L, 40L, 50L), dailyBalances(points))
    }

    @Test
    fun dailyBalancesSortAndIgnoreUnparsableDates() {
        val points = listOf(ForecastPoint("2026-11-22", 2), ForecastPoint("broken", 99), ForecastPoint("2026-11-21", 1))
        assertEquals(listOf(1L, 2L), dailyBalances(points))
        assertEquals(emptyList(), dailyBalances(emptyList()))
    }

    @Test
    fun warningsKeepOnlyAccountsThatWarn() {
        val warn = ForecastAccount("a", warning = ForecastWarning("2026-11-26", 1, 2, false))
        val fine = ForecastAccount("b")
        assertEquals(listOf(warn), warnings(listOf(fine, warn)))
    }

    @Test
    fun plannedItemsAreSignedAndTheFormIsWhatTheWebSends() {
        assertEquals("income", plannedDirection(100))
        assertEquals("expense", plannedDirection(-100))
        assertEquals("expense", plannedDirection(0))
        val withAccount = plannedFields("id1", " Rent ", "2026-12-01", "expense", " 10.00 ", "acc", "chf")
        assertEquals(
            mapOf(
                "id" to "id1",
                "label" to "Rent",
                "date" to "2026-12-01",
                "direction" to "expense",
                "amount" to "10.00",
                "accountId" to "acc",
                "currency" to null,
            ),
            withAccount,
        )
        assertEquals("CHF", plannedFields(null, "x", "2026-12-01", "income", "1", "", "chf")["currency"])
    }

    @Test
    fun settingsSendTheCheckboxLikeABrowser() {
        assertEquals(mapOf("accountId" to "a", "threshold" to "5.00", "defaultPayment" to "on"), settingsFields("a", " 5.00 ", true))
        assertEquals(null, settingsFields("a", "", false)["defaultPayment"])
    }
}
