package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ForecastContractTest {
    @Test
    fun decodesTheForecast() {
        val page = Contract.page<ForecastPage>("forecast")
        assertEquals(10, page.today.length)
        assertEquals(60, page.days)
        assertEquals(listOf(30, 60, 90), page.horizons)
        val forecast = page.forecast
        assertTrue(forecast.accounts.isNotEmpty())
        assertTrue(forecast.accounts.all { it.accountId.isNotEmpty() && it.currency.isNotEmpty() && it.points.size >= 2 })
        assertTrue(forecast.accounts.any { it.hasBalance })
        val warned = forecast.accounts.first { it.warning != null }
        assertNotNull(warned.warning)
        assertNotNull(warned.negativeDate)
        assertNotNull(warned.threshold)
        assertTrue(forecast.accounts.any { it.warning == null && it.negativeDate == null && it.threshold == null })
        assertTrue(forecast.items.isNotEmpty())
        assertTrue(forecast.items.any { it.source == "bill" && it.ref != null })
        assertTrue(forecast.items.any { it.source == "planned" })
        assertTrue(forecast.unassigned.isNotEmpty())
        assertTrue(page.planned.isNotEmpty())
        assertTrue(page.planned.all { it.id.isNotEmpty() && it.currency.isNotEmpty() })
        assertTrue(page.planned.any { it.amount < 0 })
        assertTrue(page.settings.isNotEmpty())
        assertNull(page.settings.first { it.threshold == null }.threshold)
    }
}
