package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.model.CategoriesCategory
import ch.orellbuehler.kept.model.CategoriesRule

val CATEGORY_KINDS = listOf("expense", "income")

/** The icons a category can have, by the name the server stores (`CATEGORY_ICONS` of the web). */
val CATEGORY_ICON_NAMES =
    listOf(
        "shopping-cart",
        "house",
        "utensils",
        "car",
        "heart-pulse",
        "plane",
        "film",
        "graduation-cap",
        "shield",
        "receipt",
        "wallet",
        "gift",
    )

/** The colours offered for a category (`COLOR_PALETTE` of the web). */
val CATEGORY_COLORS =
    listOf("#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777", "#7c3aed", "#64748b")

private val COLOR_PATTERN = Regex("^#[0-9a-fA-F]{6}$")

fun isColor(value: String): Boolean = COLOR_PATTERN.matches(value)

/** "Parent / Child" for a subcategory, otherwise the name. */
fun categoryLabel(
    category: CategoriesCategory,
    all: List<CategoriesCategory>,
): String {
    val parent = category.parentId?.let { id -> all.firstOrNull { it.id == id } }
    return if (parent != null) "${parent.name} / ${category.name}" else category.name
}

fun topLevelCategories(all: List<CategoriesCategory>): List<CategoriesCategory> = all.filter { it.parentId == null }

/** The categories a category of [kind] can be put under: top-level ones of the same kind, except the category itself. */
fun parentChoices(
    all: List<CategoriesCategory>,
    kind: String,
    editingId: String?,
): List<CategoriesCategory> = topLevelCategories(all).filter { it.kind == kind && it.id != editingId }

/** The parent to keep when the kind changes: none when the chosen one is no longer offered. */
fun validParent(
    parentId: String,
    choices: List<CategoriesCategory>,
): String = if (choices.any { it.id == parentId }) parentId else ""

/** What the category form holds; [color] and [icon] are empty for "none". */
data class CategoryFormValues(
    val name: String = "",
    val kind: String = "expense",
    val parentId: String = "",
    val color: String = "",
    val icon: String = "",
) {
    /** The fields of `createCategory` and `updateCategory` (plus the `id` the caller adds when editing). */
    fun fields(): List<Pair<String, String>> =
        listOf(
            "name" to name.trim(),
            "kind" to kind,
            "parentId" to parentId,
            "color" to color,
            "icon" to icon,
        )

    companion object {
        fun of(category: CategoriesCategory?): CategoryFormValues =
            if (category == null) {
                CategoryFormValues()
            } else {
                CategoryFormValues(
                    name = category.name,
                    kind = category.kind,
                    parentId = category.parentId.orEmpty(),
                    color = category.color.orEmpty(),
                    icon = category.icon.orEmpty(),
                )
            }
    }
}

/** What the rule form holds; [amountSign] is "", "expense" or "income". */
data class RuleFormValues(
    val categoryId: String = "",
    val priority: String = "100",
    val counterpartyContains: String = "",
    val descriptionContains: String = "",
    val counterpartyIban: String = "",
    val amountSign: String = "",
) {
    /** The fields of `createRule` and `updateRule` (plus the `id` the caller adds when editing). */
    fun fields(): List<Pair<String, String>> =
        listOf(
            "categoryId" to categoryId,
            "priority" to priority.trim(),
            "counterpartyContains" to counterpartyContains.trim(),
            "descriptionContains" to descriptionContains.trim(),
            "counterpartyIban" to counterpartyIban.trim().uppercase(),
            "amountSign" to amountSign,
        )

    companion object {
        fun of(
            rule: CategoriesRule?,
            categories: List<CategoriesCategory>,
        ): RuleFormValues =
            if (rule == null) {
                RuleFormValues(categoryId = categories.firstOrNull()?.id.orEmpty())
            } else {
                RuleFormValues(
                    categoryId = rule.categoryId,
                    priority = rule.priority.toString(),
                    counterpartyContains = rule.counterpartyContains.orEmpty(),
                    descriptionContains = rule.descriptionContains.orEmpty(),
                    counterpartyIban = rule.counterpartyIban.orEmpty(),
                    amountSign = rule.amountSign.orEmpty(),
                )
            }
    }
}

/** One condition of a rule, for the screen to turn into a sentence. */
sealed interface RuleCondition {
    data class CounterpartyContains(
        val text: String,
    ) : RuleCondition

    data class DescriptionContains(
        val text: String,
    ) : RuleCondition

    data class IbanIs(
        val iban: String,
    ) : RuleCondition

    data object MoneyIn : RuleCondition

    data object MoneyOut : RuleCondition
}

fun ruleConditions(rule: CategoriesRule): List<RuleCondition> =
    buildList {
        if (!rule.counterpartyContains.isNullOrEmpty()) add(RuleCondition.CounterpartyContains(rule.counterpartyContains))
        if (!rule.descriptionContains.isNullOrEmpty()) add(RuleCondition.DescriptionContains(rule.descriptionContains))
        if (!rule.counterpartyIban.isNullOrEmpty()) add(RuleCondition.IbanIs(rule.counterpartyIban))
        if (rule.amountSign == "income") add(RuleCondition.MoneyIn)
        if (rule.amountSign == "expense") add(RuleCondition.MoneyOut)
    }
