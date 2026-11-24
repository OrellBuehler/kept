package ch.orellbuehler.kept.ui.pillar3a

import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.model.Pillar3aContribution
import ch.orellbuehler.kept.model.Pillar3aGap
import ch.orellbuehler.kept.model.Pillar3aPerformance
import ch.orellbuehler.kept.model.Pillar3aPerformancePoint
import ch.orellbuehler.kept.model.Pillar3aPortfolio
import ch.orellbuehler.kept.model.Pillar3aYear

const val PILLAR_3A_CURRENCY = "CHF"

val deductions = listOf("small", "large", "none")

/** The fields of the year form; the earned income only counts for the large deduction. */
data class YearFormValues(
    val deduction: String,
    val earnedIncome: String,
) {
    fun fields(year: Int): List<Pair<String, String>> =
        listOf(
            "year" to year.toString(),
            "deduction" to deduction,
            "earnedIncome" to if (deduction == "large") earnedIncome.trim() else "",
        )

    companion object {
        fun of(row: Pillar3aYear) =
            YearFormValues(row.deduction, row.earnedIncome?.let { Amounts.toInput(it, PILLAR_3A_CURRENCY) }.orEmpty())
    }
}

/** The fields of the contribution form: a new manual one, or an edit of a detected or manual one. */
data class ContributionFormValues(
    val portfolioId: String = "",
    val amount: String = "",
    val date: String = "",
    val kind: String = "ordinary",
    val gapYears: Set<Int> = emptySet(),
    val note: String = "",
) {
    /** The year list the server parses ("2025,2026"); empty unless the contribution is a buy-in. */
    val gapYearsText: String get() = if (kind == "buy_in") gapYears.sorted().joinToString(",") else ""

    /** The fields to send; [editing] null adds a manual contribution. */
    fun fields(editing: Pillar3aContribution?): List<Pillar3aFieldPair> =
        buildList {
            when {
                editing == null -> {
                    add("portfolioId" to portfolioId)
                    add("amount" to amount.trim())
                }
                editing.isDetected -> add("transactionId" to editing.transactionId.orEmpty())
                else -> {
                    add("contributionId" to editing.id.orEmpty())
                    add("portfolioId" to portfolioId)
                    add("amount" to amount.trim())
                }
            }
            add("date" to date)
            add("kind" to kind)
            add("gapYears" to gapYearsText)
            add("note" to note.trim())
        }

    companion object {
        fun of(
            contribution: Pillar3aContribution?,
            presetKind: String?,
            firstPortfolioId: String,
            today: String,
        ): ContributionFormValues =
            if (contribution == null) {
                ContributionFormValues(portfolioId = firstPortfolioId, date = today, kind = presetKind ?: "ordinary")
            } else {
                ContributionFormValues(
                    portfolioId = contribution.portfolioId,
                    amount = Amounts.toInput(contribution.amount, PILLAR_3A_CURRENCY),
                    date = contribution.date,
                    kind = presetKind ?: contribution.kind,
                    gapYears = contribution.gapYears.toSet(),
                    note = contribution.note.orEmpty(),
                )
            }
    }
}

typealias Pillar3aFieldPair = Pair<String, String>

/** The form fields that delete (manual) or reset (detected) a contribution; null when there is nothing to send. */
fun deleteFields(contribution: Pillar3aContribution): List<Pillar3aFieldPair>? =
    when {
        contribution.isDetected -> contribution.transactionId?.let { listOf("transactionId" to it) }
        else -> contribution.id?.let { listOf("contributionId" to it) }
    }

/** Gap years a buy-in may still close: open ones, plus those the contribution being edited holds. */
fun gapCandidates(
    gaps: List<Pillar3aGap>,
    editing: Pillar3aContribution?,
): List<Pillar3aGap> = gaps.filter { it.closedBy == null || (editing?.id != null && it.closedBy == editing.id) }

/** Years that have contributions, newest first: the choices of the year filter. */
fun contributionYears(contributions: List<Pillar3aContribution>): List<Int> = contributions.map { it.year }.distinct().sortedDescending()

fun visibleContributions(
    contributions: List<Pillar3aContribution>,
    year: Int?,
): List<Pillar3aContribution> = if (year == null) contributions else contributions.filter { it.year == year }

/** Open portfolios first, then the closed ones, each group in the server's order. */
fun orderedPortfolios(portfolios: List<Pillar3aPortfolio>): List<Pillar3aPortfolio> =
    portfolios.filter { it.closedOn == null } + portfolios.filter { it.closedOn != null }

/** A portfolio with the returns reported for it, oldest first. */
class PerformanceRow(
    val portfolio: Pillar3aPortfolio,
    val points: List<Pillar3aPerformancePoint>,
) {
    val last: Pillar3aPerformancePoint get() = points.last()
}

/** The portfolios that have a reported return, in the order of the portfolio list. */
fun performanceRows(
    portfolios: List<Pillar3aPortfolio>,
    performance: List<Pillar3aPerformance>,
): List<PerformanceRow> =
    orderedPortfolios(portfolios).mapNotNull { portfolio ->
        performance
            .firstOrNull { it.portfolioId == portfolio.portfolioId }
            ?.points
            ?.takeIf { it.isNotEmpty() }
            ?.let { PerformanceRow(portfolio, it) }
    }

/** How much of the year's limit the ordinary contributions fill, 0..1. */
fun limitFraction(row: Pillar3aYear): Float = if (row.limit > 0) (row.ordinary.toFloat() / row.limit.toFloat()).coerceIn(0f, 1f) else 0f

/** The query of the live buy-in check; null while the input cannot be checked yet. */
fun buyInCheckQuery(
    values: ContributionFormValues,
    editing: Pillar3aContribution?,
): Map<String, String>? {
    if (values.kind != "buy_in" || values.date.isBlank() || values.amount.isBlank()) return null
    return buildMap {
        put("date", values.date)
        put("amount", values.amount.trim())
        put("gapYears", values.gapYearsText)
        if (editing != null) put("key", editing.key)
    }
}
