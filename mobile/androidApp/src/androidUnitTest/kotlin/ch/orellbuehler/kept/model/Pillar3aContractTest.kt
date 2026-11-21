package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class Pillar3aContractTest {
    @Test
    fun decodesThePillar3aPage() {
        val page = Contract.page<Pillar3aPage>("pillar-3a")
        assertEquals(10, page.today.length)
        assertEquals(1, page.accounts.size)
        val overview = page.overview
        assertEquals(listOf(2026, 2025), overview.years.map { it.year })
        val current = overview.years.first()
        assertEquals("large", current.deduction)
        assertNotNull(current.earnedIncome)
        assertTrue(current.limit > 0 && current.buyIn > 0)
        val past = overview.years.last()
        assertNull(past.earnedIncome)
        assertNotNull(past.closedBy)
        assertEquals(1, overview.gaps.size)
        assertEquals(past.closedBy, overview.gaps.first().closedBy)
        assertEquals(2, overview.portfolios.size)
        assertTrue(overview.portfolios.any { it.closedOn != null && it.closeReason != null })
        assertTrue(overview.portfolios.any { it.strategy == null })
        assertEquals(overview.portfolios.first().gain, overview.totals.gain)
        assertEquals(1, overview.orphanAnnotations.size)
        assertTrue(
            overview.orphanAnnotations
                .first()
                .id
                .isNotEmpty(),
        )
    }

    @Test
    fun decodesTheContributions() {
        val contributions = Contract.page<Pillar3aPage>("pillar-3a").contributions
        assertEquals(4, contributions.size)
        assertTrue(contributions.all { it.key.isNotEmpty() && it.date.length == 10 && it.portfolioId.isNotEmpty() })
        val buyIn = contributions.first { it.isBuyIn }
        assertEquals(listOf(2025), buyIn.gapYears)
        assertTrue(buyIn.isDetected && buyIn.transactionId != null && buyIn.id != null)
        assertTrue(contributions.any { it.isDetected && it.id == null && it.lateDecemberWarning != null })
        val manual = contributions.first { !it.isDetected }
        assertNull(manual.transactionId)
        assertNull(manual.bookingDate)
        assertNotNull(manual.id)
    }

    @Test
    fun decodesTheBuyInCheck() {
        val check = ApiJson.decodeFromString<Pillar3aBuyInCheck>("""{"errors":["No."],"warnings":[]}""")
        assertEquals(listOf("No."), check.errors)
        assertTrue(check.warnings.isEmpty())
    }
}
