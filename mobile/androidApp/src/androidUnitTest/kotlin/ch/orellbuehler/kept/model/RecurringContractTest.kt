package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RecurringContractTest {
    @Test
    fun decodesTheRecurringSeries() {
        val page = Contract.page<RecurringPage>("recurring")
        assertTrue(page.series.isNotEmpty())
        assertTrue(
            page.series.all { it.id.isNotEmpty() && it.name.isNotEmpty() && it.currency.isNotEmpty() && it.nextExpected.length == 10 },
        )
        assertEquals(
            setOf("confirmed", "dismissed", "suggested"),
            page.series
                .map {
                    it.status
                }.toSet()
                .intersect(setOf("confirmed", "dismissed", "suggested")),
        )
        assertTrue(page.series.all { it.cadence in listOf("weekly", "monthly", "quarterly", "yearly") })
        assertNotNull(page.series.firstOrNull { it.priceChange != null }?.priceChange)
        assertTrue(page.series.any { it.priceChange == null })
        assertTrue(page.series.any { it.amount > 0 })
        assertTrue(page.series.any { it.amount < 0 && it.annualCost < 0 })
        assertTrue(page.series.any { it.overdue })
        val total = page.totals.first()
        assertEquals("CHF", total.currency)
        assertTrue(total.outflowMonthly > 0 && total.inflowAnnual > 0)
        assertNull(page.series.first { it.priceChange == null }.priceChange)
    }
}
