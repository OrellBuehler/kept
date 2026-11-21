package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TaxesContractTest {
    @Test
    fun decodesTheTaxYears() {
        val page = Contract.page<TaxesPage>("taxes")
        assertEquals(2025, page.defaultYear)
        assertEquals("CHF", page.defaultCurrency)
        val year = page.years.single()
        assertEquals(2025, year.year)
        assertEquals("Example Tax Office", year.authority)
        assertEquals("due", year.balance.outcome)
        assertEquals(21000, year.balance.amountDue)
        assertEquals(5, year.discrepancies)
        assertEquals(false, year.reconciled)
    }

    @Test
    fun decodesTheTaxYear() {
        val page = Contract.page<TaxYearPage>("taxes.year")
        val rec = page.reconciliation
        assertEquals(2025, rec.year.year)
        assertNotNull(rec.year.id)
        assertEquals(550000L, rec.year.assessedTotal)
        assertNotNull(rec.year.notes)
        assertEquals(6, rec.rows.size)
        assertEquals(setOf("matched", "amount_mismatch", "missing_office", "missing_mine"), rec.rows.map { it.kind }.toSet())
        assertEquals(rec.counts.getValue("missing_office"), rec.rows.count { it.kind == "missing_office" })
        assertTrue(rec.rows.all { it.key.isNotEmpty() })
        val missingMine = rec.rows.first { it.kind == "missing_mine" }
        assertNull(missingMine.mine)
        assertNotNull(missingMine.office)
        assertTrue(rec.rows.any { it.office?.amount?.let { a -> a < 0 } == true })
        assertTrue(rec.rows.any { it.mine?.via == "bill" })
        assertTrue(rec.rows.any { it.mine?.via == "tagged" && it.mine?.reference != null })
        assertEquals(1, rec.suggestions.size)
        assertEquals(rec.suggestions.first().creditId, missingMine.office?.id)
        assertEquals("due", rec.balance.outcome)
        assertEquals(-160000L, rec.balance.remainingByMe)
        assertEquals(0, rec.otherCurrencyLines)
        assertEquals(0, page.deductionMoves)
    }

    @Test
    fun decodesTheDeductions() {
        val page = Contract.page<TaxYearPage>("taxes.year")
        val deductions = page.deductions
        assertEquals(2025, deductions.year)
        assertEquals(setOf("pillar_3a", "donations", "medical"), deductions.totals.map { it.type }.toSet())
        val pillar = deductions.totals.first { it.type == "pillar_3a" }
        assertTrue(pillar.lines.any { it.transactionId == null && it.source == "pillar_3a" })
        assertEquals(pillar.total, pillar.lines.sumOf { it.amount })
        assertTrue(deductions.totals.any { total -> total.lines.any { it.explicitYear } })
        val excluded = deductions.excluded.single()
        assertEquals("donations", excluded.type)
        assertNotNull(excluded.transactionId)
        assertTrue(page.deductionMappings.any { it.own == null && it.inherited && it.effective != null })
        assertTrue(page.deductionMappings.any { it.parentId != null })
        assertEquals(12, page.deductionMappings.size)
        val p3a = assertNotNull(page.pillar3a)
        assertEquals(725800L, p3a.limit)
        assertEquals(p3a.deductible, pillar.total)
    }
}
