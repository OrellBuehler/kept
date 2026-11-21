package ch.orellbuehler.kept.ui.taxes

import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.model.TaxCredit
import ch.orellbuehler.kept.model.TaxDeductionMapping
import ch.orellbuehler.kept.model.TaxReconciliation
import ch.orellbuehler.kept.model.TaxSuggestion
import ch.orellbuehler.kept.model.TaxYearDetails

val deductionTypes =
    listOf("pillar_3a", "donations", "medical", "childcare", "commuting", "education", "debt_interest", "alimony", "other")

/** The fields of the tax year form: [year] is editable when adding a year, fixed (and not sent from the form) when editing. */
data class TaxYearFormValues(
    val year: String = "",
    val authority: String = "",
    val currency: String = "",
    val assessedTotal: String = "",
    val notes: String = "",
) {
    fun fields(): List<Pair<String, String>> =
        listOf(
            "year" to year.trim(),
            "authority" to authority.trim(),
            "currency" to currency.trim().uppercase(),
            "assessedTotal" to assessedTotal.trim(),
            "notes" to notes.trim(),
        )

    companion object {
        fun forNewYear(
            year: Int,
            currency: String,
        ) = TaxYearFormValues(year = year.toString(), currency = currency)

        fun of(details: TaxYearDetails) =
            TaxYearFormValues(
                year = details.year.toString(),
                authority = details.authority.orEmpty(),
                currency = details.currency,
                assessedTotal = details.assessedTotal?.let { Amounts.toInput(it, details.currency) }.orEmpty(),
                notes = details.notes.orEmpty(),
            )
    }
}

/** A statement line of the tax office; a minus sign is money they paid back. */
data class CreditFormValues(
    val bookingDate: String = "",
    val amount: String = "",
    val reference: String = "",
    val description: String = "",
) {
    fun fields(): List<Pair<String, String>> =
        listOf(
            "bookingDate" to bookingDate,
            "amount" to amount.trim(),
            "reference" to reference.trim(),
            "description" to description.trim(),
        )
}

/** Rows that need attention: amount differs, or a line is missing on either side. */
fun differenceCount(counts: Map<String, Int>): Int =
    (counts["amount_mismatch"] ?: 0) + (counts["missing_office"] ?: 0) + (counts["missing_mine"] ?: 0)

fun suggestionsFor(
    reconciliation: TaxReconciliation,
    credit: TaxCredit,
): List<TaxSuggestion> = reconciliation.suggestions.filter { it.creditId == credit.id }

/** The server's form value for a mapping choice: "" removes the category's own deduction type. */
fun mappingChoices(): List<String> = listOf("") + deductionTypes

/** True when the type shown for the category comes from its parent. */
fun mappingIsInherited(mapping: TaxDeductionMapping): Boolean = mapping.own == null && mapping.inherited && mapping.effective != null
