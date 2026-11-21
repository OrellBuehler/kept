package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ReviewContractTest {
    @Test
    fun decodesTheYearInReview() {
        val page = Contract.page<ReviewPage>("review")
        assertEquals(page.year, page.review.year)
        assertTrue(page.firstYear in 1..page.currentYear)
        assertTrue(page.review.partial)
        assertTrue(page.review.excludedTransfers > 0)
        assertEquals(listOf("CHF", "EUR"), page.review.currencies.map { it.currency })
        val chf = page.review.currencies.first()
        assertTrue(chf.income > 0 && chf.expenses > 0 && chf.net == chf.income - chf.expenses)
        assertNotNull(chf.savingsRate)
        assertNotNull(chf.netWorth)
        assertTrue(chf.hasPreviousYear)
        assertEquals(12, chf.months.size)
        assertTrue(chf.sankey.left.isNotEmpty() && chf.sankey.right.any { it.kind == "saved" })
        assertTrue(chf.sankey.right.any { it.kind == "uncategorized" })
        assertTrue(chf.changes.any { it.changePct == null })
        assertTrue(chf.changes.any { it.changePct != null && it.change < 0 })
        assertTrue(chf.changes.any { it.categoryId == null })
        assertTrue(chf.counterparties.isNotEmpty() && chf.counterparties.all { it.count > 0 })
        assertTrue(chf.largestExpenses.all { it.amount < 0 } && chf.largestIncome.all { it.amount > 0 })
        assertTrue(chf.largestExpenses.any { it.categoryName != null })
        val eur = page.review.currencies.last()
        assertTrue(!eur.hasPreviousYear)
        assertTrue(eur.largestExpenses.any { it.categoryName == null })
    }
}
