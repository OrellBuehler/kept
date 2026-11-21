package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.model.CategoriesCategory
import ch.orellbuehler.kept.model.CategoriesRule
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CategoriesLogicTest {
    private val food = CategoriesCategory("food", "Food", kind = "expense")
    private val groceries = CategoriesCategory("groceries", "Groceries", parentId = "food", kind = "expense")
    private val salary = CategoriesCategory("salary", "Salary", kind = "income", color = "#2e7d32", icon = "wallet")
    private val all = listOf(food, groceries, salary)

    @Test
    fun subcategoriesAreLabelledWithTheirParent() {
        assertEquals("Food / Groceries", categoryLabel(groceries, all))
        assertEquals("Food", categoryLabel(food, all))
        assertEquals("Orphan", categoryLabel(CategoriesCategory("x", "Orphan", parentId = "gone"), all))
    }

    @Test
    fun onlyTopLevelCategoriesOfTheSameKindCanBeParents() {
        assertEquals(listOf("food"), parentChoices(all, "expense", null).map { it.id })
        assertEquals(listOf("salary"), parentChoices(all, "income", null).map { it.id })
        assertTrue(parentChoices(all, "expense", "food").isEmpty())
        assertEquals(listOf("food", "salary"), topLevelCategories(all).map { it.id })
    }

    @Test
    fun aParentThatIsNoLongerOfferedIsDropped() {
        val choices = parentChoices(all, "income", null)
        assertEquals("", validParent("food", choices))
        assertEquals("salary", validParent("salary", choices))
        assertEquals("", validParent("", choices))
    }

    @Test
    fun theCategoryFormSendsTheFieldsOfTheWebForm() {
        val values = CategoryFormValues(" Rent ", "expense", "", "#2563eb", "house")
        assertEquals(
            listOf("name" to "Rent", "kind" to "expense", "parentId" to "", "color" to "#2563eb", "icon" to "house"),
            values.fields(),
        )
        assertEquals(CategoryFormValues(), CategoryFormValues.of(null))
        val edit = CategoryFormValues.of(groceries.copy(color = null, icon = null))
        assertEquals("food", edit.parentId)
        assertEquals("", edit.color)
        assertEquals("", edit.icon)
        assertEquals("income", CategoryFormValues.of(salary).kind)
    }

    @Test
    fun theRuleFormSendsTheFieldsOfTheWebForm() {
        val values = RuleFormValues("groceries", " 10 ", " Grocer ", "", "ab12", "expense")
        assertEquals(
            listOf(
                "categoryId" to "groceries",
                "priority" to "10",
                "counterpartyContains" to "Grocer",
                "descriptionContains" to "",
                "counterpartyIban" to "AB12",
                "amountSign" to "expense",
            ),
            values.fields(),
        )
    }

    @Test
    fun aNewRuleStartsWithTheFirstCategoryAndPriority100() {
        val fresh = RuleFormValues.of(null, all)
        assertEquals("food", fresh.categoryId)
        assertEquals("100", fresh.priority)
        assertEquals("", RuleFormValues.of(null, emptyList()).categoryId)
        val rule = CategoriesRule("r", "groceries", "Groceries", 20, counterpartyContains = "Grocer", amountSign = "expense")
        val edit = RuleFormValues.of(rule, all)
        assertEquals("20", edit.priority)
        assertEquals("Grocer", edit.counterpartyContains)
        assertEquals("", edit.descriptionContains)
        assertEquals("expense", edit.amountSign)
    }

    @Test
    fun aRuleListsItsConditionsInOrder() {
        val rule =
            CategoriesRule(
                "r",
                "c",
                priority = 1,
                counterpartyContains = "A",
                descriptionContains = "B",
                counterpartyIban = "C",
                amountSign = "income",
            )
        assertEquals(
            listOf(
                RuleCondition.CounterpartyContains("A"),
                RuleCondition.DescriptionContains("B"),
                RuleCondition.IbanIs("C"),
                RuleCondition.MoneyIn,
            ),
            ruleConditions(rule),
        )
        assertEquals(listOf(RuleCondition.MoneyOut), ruleConditions(CategoriesRule("r", "c", amountSign = "expense")))
        assertTrue(ruleConditions(CategoriesRule("r", "c", counterpartyContains = "")).isEmpty())
    }

    @Test
    fun colours() {
        assertTrue(CATEGORY_COLORS.all { isColor(it) })
        assertFalse(isColor("red"))
        assertFalse(isColor("#12345"))
        assertEquals(12, CATEGORY_ICON_NAMES.size)
        assertEquals(12, CATEGORY_ICON_NAMES.map { categoryIcon(it) }.toSet().size)
    }
}
