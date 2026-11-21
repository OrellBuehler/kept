package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BudgetsContractTest {
    @Test
    fun decodesTheBudgets() {
        val page = Contract.page<BudgetsPage>("budgets")
        assertEquals(7, page.month.length)
        assertEquals("share", page.basis)
        assertTrue(page.hasShared)
        assertTrue(page.previousMonth.isNotEmpty() && page.nextMonth.isNotEmpty() && page.currentMonth.isNotEmpty())
        val chf = page.report.currencies.first()
        assertEquals("CHF", chf.currency)
        assertTrue(chf.rows.isNotEmpty())
        assertTrue(chf.rows.all { it.budgetId.isNotEmpty() && it.categoryName.isNotEmpty() })
        assertTrue(chf.rows.any { it.over && it.remaining < 0 })
        assertNotNull(chf.rows.first().parentName)
        assertNull(chf.rows.first { it.categoryName == "Housing" }.parentName)
        assertTrue(chf.unbudgeted.isNotEmpty())
        assertTrue(chf.totalBudget > 0 && chf.totalSpent > 0)
        assertTrue(page.categories.any { it.kind == "income" })
        assertTrue(page.categories.any { it.parentId != null })
        assertEquals(listOf("CHF", "EUR"), page.currencies)
    }
}
