package ch.orellbuehler.kept.ui.budgets

import ch.orellbuehler.kept.model.BudgetCategory
import kotlin.test.Test
import kotlin.test.assertEquals

class BudgetsLogicTest {
    private val food = BudgetCategory("a", "Food")
    private val groceries = BudgetCategory("b", "Groceries", parentId = "a")
    private val salary = BudgetCategory("c", "Salary", kind = "income")

    @Test
    fun percentIsClamped() {
        assertEquals(0, budgetPercent(0, 100))
        assertEquals(50, budgetPercent(50, 100))
        assertEquals(100, budgetPercent(250, 100))
        assertEquals(0, budgetPercent(10, 0))
        assertEquals(0, budgetPercent(-10, 100))
    }

    @Test
    fun labelsSubcategoriesWithTheirParent() {
        val all = listOf(food, groceries, salary)
        assertEquals("Food / Groceries", budgetCategoryLabel(groceries, all))
        assertEquals("Food", budgetCategoryLabel(food, all))
    }

    @Test
    fun onlyExpenseCategoriesCanBeBudgeted() {
        assertEquals(listOf(food, groceries), expenseCategories(listOf(food, groceries, salary)))
    }

    @Test
    fun queryOmitsWhatIsNotSet() {
        assertEquals(emptyMap(), budgetsQuery(null, null))
        assertEquals(mapOf("month" to "2026-10"), budgetsQuery("2026-10", ""))
        assertEquals(mapOf("month" to "2026-10", "basis" to "total"), budgetsQuery("2026-10", "total"))
    }

    @Test
    fun formSendsWhatTheWebFormSends() {
        assertEquals(
            mapOf("id" to null, "categoryId" to "cat", "currency" to "CHF", "amount" to "400.00"),
            budgetFields(null, "cat", " chf ", " 400.00 "),
        )
        assertEquals("id1", budgetFields("id1", "cat", "CHF", "1")["id"])
    }
}
