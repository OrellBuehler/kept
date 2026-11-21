package ch.orellbuehler.kept.ui.budgets

import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.model.BudgetCategory

/** The share of a budget that is spent, 0..100, like the web's progress bar. */
fun budgetPercent(
    spent: Long,
    budget: Long,
): Int {
    if (budget <= 0) return 0
    return Math.round(spent.toDouble() / budget * 100).toInt().coerceIn(0, 100)
}

/** "Parent / Child" for a subcategory, the name otherwise. */
fun budgetCategoryLabel(
    category: BudgetCategory,
    all: List<BudgetCategory>,
): String {
    val parent = category.parentId?.let { id -> all.firstOrNull { it.id == id } }
    return if (parent != null) "${parent.name} / ${category.name}" else category.name
}

fun expenseCategories(all: List<BudgetCategory>): List<BudgetCategory> = all.filter { it.kind == "expense" }

/** The query of the page: the month, and the basis once the user chose one. */
fun budgetsQuery(
    month: String?,
    basis: String?,
): Map<String, String> =
    buildMap {
        if (!month.isNullOrBlank()) put("month", month)
        if (!basis.isNullOrBlank()) put("basis", basis)
    }

/** The fields of the web's budget form; [id] is set when editing. A null value is not sent. */
fun budgetFields(
    id: String?,
    categoryId: String,
    currency: String,
    amount: String,
): Map<String, String?> =
    linkedMapOf(
        "id" to id,
        "categoryId" to categoryId,
        "currency" to currency.trim().uppercase(),
        "amount" to amount.trim(),
    )

fun Map<String, String?>.toFormBody(): FormBody = FormBody().also { form -> forEach { (name, value) -> form.set(name, value) } }
