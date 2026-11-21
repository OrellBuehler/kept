package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InvestmentsContractTest {
    @Test
    fun decodesTheInvestments() {
        val page = Contract.page<InvestmentsPage>("investments")
        val total = page.overview.totals.first()
        assertEquals("CHF", total.currency)
        assertEquals(total.value - total.cost, total.gain)
        assertTrue(page.overview.securities.isNotEmpty())
        val group = page.overview.securities.first()
        assertTrue(group.securityId.isNotEmpty() && group.quantity > 0 && group.price > 0)
        assertTrue(group.positions.all { it.accountId.isNotEmpty() && it.accountCurrency.isNotEmpty() })
        assertTrue(page.overview.securities.any { it.priceSource == "provider" })
        assertEquals(3, page.securities.size)
        assertTrue(page.securities.any { it.isin == null && it.symbol == null })
        assertTrue(page.securities.any { it.symbol != null })
        assertEquals(false, page.marketData.canLookup)
    }

    @Test
    fun decodesThePriceHistory() {
        val history = Contract.page<InvestmentsPage>("investments").priceHistory!!
        assertEquals("EXWLD", history.security.symbol)
        assertEquals(history.total, history.prices.size)
        assertTrue(history.prices.any { it.source == "manual" })
        assertTrue(history.prices.all { it.id.isNotEmpty() && it.date.length == 10 && it.price > 0 })
    }
}
