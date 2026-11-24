package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class DashboardContractTest {
    @Test
    fun decodesTheDashboard() {
        val page = Contract.page<DashboardPage>("dashboard")
        val dashboard = page.dashboard
        assertEquals(10, page.today.length)
        assertTrue(dashboard.netWorth.totals.isNotEmpty())
        assertTrue(
            dashboard.netWorth.series
                .first()
                .points.size >= 2,
        )
        assertTrue(dashboard.accounts.any { it.institution != null })
        assertTrue(dashboard.accounts.any { it.lastImportAt != null })
        assertTrue(dashboard.accounts.all { it.id.isNotEmpty() && it.currency.isNotEmpty() })
        assertTrue(dashboard.month.totals.isNotEmpty())
        assertTrue(dashboard.spending.currencies.any { it.items.isNotEmpty() })
        assertTrue(dashboard.bills.upcoming.isNotEmpty())
        assertNotNull(
            dashboard.bills.upcoming
                .first()
                .dueDate,
        )
        assertTrue(page.forecastAlerts.isNotEmpty())
        assertTrue(page.needsAmount.isNotEmpty())
    }

    @Test
    fun decodesTheCheckedStampOfAStaleAccount() {
        val account =
            ApiJson.decodeFromString<DashboardAccount>(
                """{"id":"a","name":"Example Checking","lastImportAt":1795372853185,"lastCheckedAt":1795459253185,"stale":true,"staleDays":50}""",
            )
        assertEquals(1795459253185, account.lastCheckedAt)
        assertEquals(50, account.staleDays)
    }
}
