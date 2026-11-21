package ch.orellbuehler.kept.ui.recurring

import ch.orellbuehler.kept.model.RecurringSeries
import kotlin.test.Test
import kotlin.test.assertEquals

class RecurringLogicTest {
    @Test
    fun groupsBySeriesStatusKeepingOrder() {
        val a = RecurringSeries("a", status = "confirmed")
        val b = RecurringSeries("b", status = "suggested")
        val c = RecurringSeries("c", status = "dismissed")
        val d = RecurringSeries("d", status = "confirmed")
        val groups = groupSeries(listOf(a, b, c, d))
        assertEquals(listOf(b), groups.suggested)
        assertEquals(listOf(a, d), groups.confirmed)
        assertEquals(listOf(c), groups.dismissed)
    }

    @Test
    fun editSendsWhatTheWebFormSends() {
        assertEquals(
            mapOf("id" to "1", "name" to "Rent", "cadence" to "monthly", "amount" to "12.50"),
            editFields("1", " Rent ", "monthly", " 12.50 "),
        )
        assertEquals(mapOf("id" to "1"), idFields("1"))
    }

    @Test
    fun theCadencesAreTheOnesTheServerAccepts() {
        assertEquals(listOf("weekly", "monthly", "quarterly", "yearly"), cadences)
    }
}
