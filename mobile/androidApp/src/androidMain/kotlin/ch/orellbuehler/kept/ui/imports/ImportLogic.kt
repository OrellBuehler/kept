package ch.orellbuehler.kept.ui.imports

import ch.orellbuehler.kept.model.ImportAccount
import ch.orellbuehler.kept.model.ImportCounts
import ch.orellbuehler.kept.model.ImportPendingPage
import ch.orellbuehler.kept.model.ImportTx
import ch.orellbuehler.kept.ui.common.Formats
import ch.orellbuehler.kept.ui.components.Choice
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The server accepts statements up to 20 MB (`MAX_UPLOAD_BYTES`), but the file travels base64 encoded in a JSON body that
 * the server's body limit (25 MB) caps, so the largest file the app can send is a little under 19 MB.
 */
const val MAX_IMPORT_BYTES = 18L * 1024 * 1024

/** What the server's own limit is, for the message that explains why a larger file is refused. */
const val SERVER_IMPORT_LIMIT_MB = 20

const val MAPPING_REQUIRED = "mapping_required"

/** The kinds of status a row of the preview has. */
enum class ImportRowStatus {
    NEW,
    REPLACES_MIRROR,
    DUPLICATE,
    DUPLICATE_IN_FILE,
    ;

    companion object {
        fun fromApi(value: String): ImportRowStatus =
            when (value) {
                "replaces_mirror" -> REPLACES_MIRROR
                "duplicate" -> DUPLICATE
                "duplicate_in_file" -> DUPLICATE_IN_FILE
                else -> NEW
            }
    }
}

/** "Example Checking (CHF) · Example Bank" */
fun accountLabel(account: ImportAccount): String =
    buildString {
        append(account.name)
        if (account.currency.isNotEmpty()) append(" (${account.currency})")
        if (!account.institutionName.isNullOrBlank()) append(" · ${account.institutionName}")
    }

fun accountChoices(accounts: List<ImportAccount>): List<Choice> = accounts.map { Choice(it.id, accountLabel(it)) }

/** The account to start with: the one the page preselects, or the only one there is. */
fun initialAccountId(
    accounts: List<ImportAccount>,
    selected: String?,
): String = accounts.firstOrNull { it.id == selected }?.id ?: accounts.singleOrNull()?.id.orEmpty()

/** The name of a file format as the web shows it. */
fun formatName(format: String): String =
    when (format) {
        "camt053" -> "camt.053"
        "camt054" -> "camt.054"
        "mt940" -> "MT940"
        "csv" -> "CSV"
        "xlsx" -> "Excel"
        else -> format.uppercase(Locale.ROOT)
    }

/** True for the formats that need a column mapping (CSV and Excel). */
fun isTabular(format: String): Boolean = format == "csv" || format == "xlsx"

/** "812 B", "3.4 KB", "1.5 MB": the size of a file, the same in every locale. */
fun formatBytes(bytes: Long): String =
    when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0))
    }

/** "12 Mar 2026 – 19 Mar 2026", a single date when both ends are the same, null when the file declares no period. */
fun formatPeriod(
    from: String?,
    to: String?,
    formats: Formats,
): String? =
    when {
        !from.isNullOrEmpty() && !to.isNullOrEmpty() ->
            if (from ==
                to
            ) {
                formats.date(from)
            } else {
                "${formats.date(from)} – ${formats.date(to)}"
            }
        !from.isNullOrEmpty() -> formats.date(from)
        !to.isNullOrEmpty() -> formats.date(to)
        else -> null
    }

/** An instant in epoch milliseconds as date and time of the user's locale and the device's zone. */
fun formatDateTime(
    millis: Long,
    locale: Locale,
    zone: ZoneId = ZoneId.systemDefault(),
): String =
    DateTimeFormatter
        .ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withLocale(locale)
        .format(Instant.ofEpochMilli(millis).atZone(zone))

/** What names a row: the counterparty, else the description. */
fun rowTitle(tx: ImportTx): String = tx.counterpartyName?.takeIf { it.isNotBlank() } ?: tx.description?.takeIf { it.isNotBlank() } ?: "—"

/** The description under the title, only when there is a counterparty to tell it apart from. */
fun rowSubtitle(tx: ImportTx): String? = tx.description?.takeIf { it.isNotBlank() && !tx.counterpartyName.isNullOrBlank() }

/** One tab of the filter above the rows: the value the page takes in `filter` and the count it shows. */
data class ImportFilter(
    val value: String,
    val count: Int,
)

/** Rows that will be imported without replacing a mirror. */
fun brandNew(counts: ImportCounts): Int = counts.new - counts.replacesMirror

fun importFilters(counts: ImportCounts): List<ImportFilter> =
    buildList {
        add(ImportFilter("all", counts.total))
        add(ImportFilter("new", brandNew(counts)))
        if (counts.replacesMirror > 0) add(ImportFilter("replaces_mirror", counts.replacesMirror))
        add(ImportFilter("duplicate", counts.duplicate))
    }

/** The query the preview page reads: the filter and the page number, left out when they are the defaults. */
fun pendingQuery(
    filter: String,
    page: Int,
): Map<String, String> =
    buildMap {
        if (filter != "all") put("filter", filter)
        if (page > 1) put("page", page.toString())
    }

/** The problems of the file apart from the missing mapping, which has its own button. */
fun otherErrors(errors: List<String>): List<String> = errors.filter { it != MAPPING_REQUIRED }

/** What the import button of the preview does. */
sealed interface ConfirmState {
    /** Imports [count] transactions. */
    data class Import(
        val count: Int,
    ) : ConfirmState

    /** The file is fine but everything in it is already in the account. */
    data object NothingNew : ConfirmState

    /** The file has errors: it cannot be imported yet. */
    data object Blocked : ConfirmState
}

fun confirmState(page: ImportPendingPage): ConfirmState =
    when {
        !page.canConfirm -> ConfirmState.Blocked
        page.counts.new == 0 -> ConfirmState.NothingNew
        else -> ConfirmState.Import(page.counts.new)
    }

/** The first and last row number shown on the current page of rows. */
fun rowRange(page: ImportPendingPage): Pair<Int, Int> {
    val first = (page.page - 1) * page.pageSize + 1
    val last = minOf(page.page * page.pageSize, page.filteredTotal)
    return first to last
}

/** The status of a file of the watch folder. */
enum class InboxStatus {
    IMPORTED,
    REVIEW,
    FAILED,
    DUPLICATE,
    ;

    companion object {
        fun fromApi(value: String): InboxStatus =
            when (value) {
                "imported" -> IMPORTED
                "review" -> REVIEW
                "failed" -> FAILED
                else -> DUPLICATE
            }
    }
}
