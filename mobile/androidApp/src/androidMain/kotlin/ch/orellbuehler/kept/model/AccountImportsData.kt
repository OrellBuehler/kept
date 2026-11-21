package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/accounts/<id>/imports`. */
@Serializable
data class AccountImportsPage(
    val account: AccountsAccount,
    val imports: List<AccountImportRow> = emptyList(),
    /** What undoing an import deletes besides its rows, by import id. */
    val impacts: Map<String, AccountImportImpact> = emptyMap(),
)

@Serializable
data class AccountImportRow(
    val id: String,
    val currency: String = "",
    /** "camt053", "camt054", "mt940", "csv" or "xlsx". */
    val format: String = "",
    val fileName: String = "",
    val statementFrom: String? = null,
    val statementTo: String? = null,
    val openingBalance: Long? = null,
    val closingBalance: Long? = null,
    val newCount: Int = 0,
    val duplicateCount: Int = 0,
    val warnings: List<String> = emptyList(),
    val createdAt: Long = 0,
)

@Serializable
data class AccountImportImpact(
    val transactions: Int = 0,
    val categorized: Int = 0,
    val notes: Int = 0,
    val taxYears: Int = 0,
    val deductionYears: Int = 0,
    val billAllocations: Int = 0,
    val pillar3a: Int = 0,
    val transferLinks: Int = 0,
    val mirrors: Int = 0,
)
