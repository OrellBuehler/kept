package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** `GET pages/import`: where a statement can be imported to, the recent imports and the watch folder. */
@Serializable
data class ImportPage(
    val accounts: List<ImportAccount> = emptyList(),
    val recentImports: List<ImportRecent> = emptyList(),
    val inbox: ImportInbox = ImportInbox(),
    val selectedAccountId: String? = null,
)

@Serializable
data class ImportAccount(
    val id: String,
    val name: String = "",
    val currency: String = "",
    val institutionName: String? = null,
    val institution: InstitutionRef? = null,
)

@Serializable
data class ImportRecent(
    val id: String,
    val accountId: String = "",
    val accountName: String = "",
    val currency: String = "",
    val format: String = "",
    val fileName: String = "",
    val statementFrom: String? = null,
    val statementTo: String? = null,
    val newCount: Int = 0,
    val duplicateCount: Int = 0,
    val warnings: List<String> = emptyList(),
    val createdAt: Long = 0,
)

/** The watch folder: [enabled] is false when the server has none configured. */
@Serializable
data class ImportInbox(
    val enabled: Boolean = false,
    val lastScan: ImportInboxScan? = null,
    val entries: List<ImportInboxEntry> = emptyList(),
)

@Serializable
data class ImportInboxScan(
    val at: Long = 0,
    val imported: Int = 0,
    val review: Int = 0,
    val failed: Int = 0,
    val duplicate: Int = 0,
    val skipped: Int = 0,
)

/** One file of the watch folder; [status] is "imported", "review", "failed" or "duplicate". */
@Serializable
data class ImportInboxEntry(
    val id: String,
    val fileName: String = "",
    val status: String = "",
    val reason: String? = null,
    val accountName: String? = null,
    val newCount: Int? = null,
    val duplicateCount: Int? = null,
    val updatedAt: Long = 0,
)

@Serializable
data class ImportPendingAccount(
    val id: String,
    val name: String = "",
    val currency: String = "",
    val iban: String? = null,
)

@Serializable
data class ImportBalance(
    val amount: Long = 0,
    val currency: String = "",
    val date: String = "",
)

@Serializable
data class ImportStatement(
    val currency: String? = null,
    val fromDate: String? = null,
    val toDate: String? = null,
    val openingBalance: ImportBalance? = null,
    val closingBalance: ImportBalance? = null,
)

/** The balance check of a statement against the ledger; [code] is "opening_mismatch" or "closing_mismatch". */
@Serializable
data class ImportBalanceWarning(
    val code: String = "",
    val date: String = "",
    val fileAmount: Long = 0,
    val ledgerAmount: Long = 0,
    val currency: String = "",
)

/** A transaction as read from the file: shown in the preview and on the mapping page. */
@Serializable
data class ImportTx(
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val counterpartyName: String? = null,
    val description: String? = null,
    val reference: String? = null,
)

/** One row of the preview; [status] is "new", "replaces_mirror", "duplicate" or "duplicate_in_file". */
@Serializable
data class ImportPendingRow(
    val index: Int = 0,
    val status: String = "new",
    val matchedBy: String? = null,
    val tx: ImportTx = ImportTx(),
)

@Serializable
data class ImportCounts(
    val new: Int = 0,
    val replacesMirror: Int = 0,
    val duplicate: Int = 0,
    val total: Int = 0,
)

/** `GET pages/import/<pendingId>`: the preview of an uploaded file. */
@Serializable
data class ImportPendingPage(
    val pendingId: String,
    val account: ImportPendingAccount,
    val format: String = "",
    val fileName: String = "",
    val statement: ImportStatement? = null,
    val rows: List<ImportPendingRow> = emptyList(),
    val counts: ImportCounts = ImportCounts(),
    val warnings: List<String> = emptyList(),
    val balanceWarnings: List<ImportBalanceWarning> = emptyList(),
    val errors: List<String> = emptyList(),
    val alreadyImportedAt: Long? = null,
    val filter: String = "all",
    val page: Int = 1,
    val pageSize: Int = 100,
    val pageCount: Int = 1,
    val filteredTotal: Int = 0,
    val needsMapping: Boolean = false,
    val canConfirm: Boolean = false,
)

@Serializable
data class ImportMappingAccount(
    val id: String,
    val name: String = "",
    val currency: String = "",
)

/** A column of the file: its header (or "" without one), its position and a few values. */
@Serializable
data class ImportDetectedColumn(
    val index: Int = 0,
    val name: String = "",
    val samples: List<String> = emptyList(),
)

/** One row of the file read with the current mapping: either [transaction] or [error]. */
@Serializable
data class ImportPreviewRow(
    val rowNumber: Int = 0,
    val raw: List<String> = emptyList(),
    val transaction: ImportTx? = null,
    val error: String? = null,
)

/** A mapping saved for another account, offered as a starting point. */
@Serializable
data class ImportOtherProfile(
    val accountId: String = "",
    val accountName: String = "",
    val name: String = "",
    val profile: JsonObject = JsonObject(emptyMap()),
)

/**
 * `GET pages/import/<pendingId>/mapping` and the answer of the live preview endpoint (which has no
 * [otherProfiles]). [profile] is null while the draft mapping is not valid. [draft] is the profile
 * object the form starts from; its column values are names, indexes or lists of them.
 */
@Serializable
data class ImportMappingPage(
    val pendingId: String = "",
    val fileName: String = "",
    val format: String = "csv",
    val account: ImportMappingAccount = ImportMappingAccount(""),
    val detected: List<ImportDetectedColumn> = emptyList(),
    val sampleRows: List<List<String>> = emptyList(),
    val preview: List<ImportPreviewRow> = emptyList(),
    val profile: JsonElement? = null,
    val draft: JsonObject = JsonObject(emptyMap()),
    val saved: Boolean = false,
    val savedName: String? = null,
    val rowCount: Int = 0,
    val dataRowCount: Int = 0,
    val errors: List<String> = emptyList(),
    val otherProfiles: List<ImportOtherProfile> = emptyList(),
)
