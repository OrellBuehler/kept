package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/taxes`: every tax year that has details or tagged payments. */
@Serializable
data class TaxesPage(
    val years: List<TaxYearSummary> = emptyList(),
    val defaultYear: Int = 0,
    val defaultCurrency: String = "CHF",
)

@Serializable
data class TaxYearSummary(
    val year: Int,
    val authority: String? = null,
    val currency: String = "CHF",
    val balance: TaxBalance = TaxBalance(),
    val discrepancies: Int = 0,
    val reconciled: Boolean = false,
)

/** What was paid, what the tax office counted and what is left, in minor units of the year's currency. */
@Serializable
data class TaxBalance(
    val paidByMe: Long = 0,
    val creditedByOffice: Long = 0,
    val difference: Long = 0,
    val assessedTotal: Long? = null,
    val remaining: Long? = null,
    val remainingByMe: Long? = null,
    /** "due", "refund", "settled" or "unknown" (no assessment). */
    val outcome: String = "unknown",
    val amountDue: Long = 0,
    val refundExpected: Long = 0,
)

/** `GET pages/taxes/<year>`. */
@Serializable
data class TaxYearPage(
    val reconciliation: TaxReconciliation,
    /** Transactions moved from tax payment to deduction year during an update, waiting for review. */
    val deductionMoves: Int = 0,
    val deductions: TaxDeductionSummary = TaxDeductionSummary(),
    val deductionMappings: List<TaxDeductionMapping> = emptyList(),
    /** Null unless the user tracks pillar 3a. */
    val pillar3a: TaxPillar3a? = null,
)

@Serializable
data class TaxReconciliation(
    val year: TaxYearDetails,
    val rows: List<TaxRow> = emptyList(),
    val balance: TaxBalance = TaxBalance(),
    /** Row counts by kind: matched, amount_mismatch, missing_office, missing_mine. */
    val counts: Map<String, Int> = emptyMap(),
    val reconciled: Boolean = false,
    val otherCurrencyLines: Int = 0,
    val suggestions: List<TaxSuggestion> = emptyList(),
)

@Serializable
data class TaxYearDetails(
    /** Null while the year only exists through tagged payments. */
    val id: String? = null,
    val year: Int,
    val authority: String? = null,
    val currency: String = "CHF",
    val assessedTotal: Long? = null,
    val notes: String? = null,
)

/** One line of the reconciliation: your payment, the tax office's line, or both. */
@Serializable
data class TaxRow(
    /** "matched", "amount_mismatch", "missing_office" or "missing_mine". */
    val kind: String,
    val date: String = "",
    val mine: TaxPayment? = null,
    val office: TaxCredit? = null,
    val difference: Long = 0,
) {
    val key: String get() = mine?.id ?: office?.id.orEmpty()
}

@Serializable
data class TaxPayment(
    val id: String,
    val transactionId: String = "",
    val accountId: String = "",
    val currency: String = "",
    val date: String = "",
    val amount: Long = 0,
    val reference: String? = null,
    val label: String? = null,
    /** "tagged" (the transaction carries the year) or "bill" (allocated to a bill that does). */
    val via: String = "tagged",
)

/** A line of the tax office's statement: positive counted, negative repaid. */
@Serializable
data class TaxCredit(
    val id: String,
    val date: String = "",
    val amount: Long = 0,
    val reference: String? = null,
    val description: String? = null,
)

/** A transaction that may be the payment a statement line is missing. */
@Serializable
data class TaxSuggestion(
    val creditId: String,
    val transactionId: String,
    val accountId: String = "",
    val bookingDate: String = "",
    val amount: Long = 0,
    val label: String? = null,
)

@Serializable
data class TaxDeductionSummary(
    val year: Int = 0,
    val totals: List<TaxDeductionTotal> = emptyList(),
    val excluded: List<TaxDeductionLine> = emptyList(),
)

@Serializable
data class TaxDeductionTotal(
    val type: String,
    val currency: String = "",
    val total: Long = 0,
    val lines: List<TaxDeductionLine> = emptyList(),
)

@Serializable
data class TaxDeductionLine(
    val key: String,
    /** Null for a manual pillar 3a contribution, which has no transaction. */
    val transactionId: String? = null,
    val source: String = "category",
    val date: String = "",
    val label: String? = null,
    val amount: Long = 0,
    val currency: String = "",
    val explicitYear: Boolean = false,
    /** Only on excluded lines. */
    val type: String? = null,
)

@Serializable
data class TaxDeductionMapping(
    val categoryId: String,
    val name: String = "",
    val parentId: String? = null,
    /** The deduction type set on this category itself. */
    val own: String? = null,
    /** Own type, else the parent's. */
    val effective: String? = null,
    val inherited: Boolean = false,
)

@Serializable
data class TaxPillar3a(
    val limit: Long? = null,
    val limitUnconfirmed: Boolean = false,
    val ordinary: Long = 0,
    val buyIn: Long = 0,
    val deductible: Long = 0,
    val excluded: Long = 0,
)
