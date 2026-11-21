package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/budgets?month=YYYY-MM&basis=share|total`. Amounts are minor units of the currency of their report. */
@Serializable
data class BudgetsPage(
    val month: String = "",
    val basis: String = "share",
    val hasShared: Boolean = false,
    val currentMonth: String = "",
    val previousMonth: String = "",
    val nextMonth: String = "",
    val report: BudgetReport = BudgetReport(),
    val categories: List<BudgetCategory> = emptyList(),
    val currencies: List<String> = emptyList(),
)

@Serializable
data class BudgetReport(
    val month: String = "",
    val currencies: List<BudgetCurrencyReport> = emptyList(),
)

@Serializable
data class BudgetCurrencyReport(
    val currency: String,
    val rows: List<BudgetRow> = emptyList(),
    val unbudgeted: List<BudgetUnbudgetedRow> = emptyList(),
    val totalBudget: Long = 0,
    val totalSpent: Long = 0,
)

@Serializable
data class BudgetRow(
    val budgetId: String,
    val categoryId: String,
    val categoryName: String = "",
    val parentName: String? = null,
    val color: String? = null,
    val icon: String? = null,
    val budget: Long = 0,
    val spent: Long = 0,
    /** Budget minus spent; negative when over. */
    val remaining: Long = 0,
    val over: Boolean = false,
)

@Serializable
data class BudgetUnbudgetedRow(
    val categoryId: String,
    val categoryName: String = "",
    val parentName: String? = null,
    val color: String? = null,
    val icon: String? = null,
    val spent: Long = 0,
)

@Serializable
data class BudgetCategory(
    val id: String,
    val name: String = "",
    val parentId: String? = null,
    val kind: String = "expense",
    val color: String? = null,
    val icon: String? = null,
)
