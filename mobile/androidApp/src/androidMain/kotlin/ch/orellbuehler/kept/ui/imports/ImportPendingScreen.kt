package ch.orellbuehler.kept.ui.imports

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ImportBalance
import ch.orellbuehler.kept.model.ImportBalanceWarning
import ch.orellbuehler.kept.model.ImportPendingPage
import ch.orellbuehler.kept.model.ImportPendingRow
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.reports.ibanLabel
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class ImportPendingViewModel(
    sdk: KeptSdk,
    private val pendingId: String,
    private val filter: MutableStateFlow<String> = MutableStateFlow("all"),
    private val pageNumber: MutableStateFlow<Int> = MutableStateFlow(1),
) : PageViewModel<ImportPendingPage>(
        sdk,
        { it.load("import/$pendingId", pendingQuery(filter.value, pageNumber.value)) },
    ) {
    val selectedFilter: StateFlow<String> = filter.asStateFlow()

    fun selectFilter(value: String) {
        if (filter.value == value) return
        filter.value = value
        pageNumber.value = 1
        refresh()
    }

    fun goToPage(page: Int) {
        pageNumber.value = page
        refresh()
    }

    /** Imports the new transactions; the page answers with the account they went to. */
    fun confirm() = submit("import/$pendingId", "confirm", reload = false)

    /** Throws the uploaded file away; the page answers with the import page. */
    fun cancel() = submit("import/$pendingId", "cancel", reload = false)
}

/** What would be imported from an uploaded file, and the buttons to import it or throw it away. */
@Composable
fun ImportPendingScreen(
    pendingId: String,
    nav: Navigator,
) {
    val vm = keptViewModel(key = "import-$pendingId") { ImportPendingViewModel(it, pendingId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val filter by vm.selectedFilter.collectAsStateWithLifecycle()
    var confirmCancel by remember { mutableStateOf(false) }
    PageScaffold(
        title = stringResource(R.string.imports_review_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event -> if (event is UiEvent.Navigate) nav.openWebPath(event.webPath, replace = true) },
    ) { page, padding ->
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                contentPadding = padding,
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item { SummaryCard(page) }
                if (page.alreadyImportedAt != null) item { AlreadyImported(page.alreadyImportedAt) }
                if (page.warnings.isNotEmpty() || page.balanceWarnings.isNotEmpty()) item { WarningsCard(page) }
                if (page.errors.isNotEmpty()) {
                    item { ErrorsCard(page, onMap = { nav.replace(Routes.importMapping(page.pendingId)) }) }
                }
                if (isTabular(page.format) && !page.needsMapping) {
                    item {
                        OutlinedButton(
                            onClick = { nav.replace(Routes.importMapping(page.pendingId)) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(stringResource(R.string.imports_edit_mapping))
                        }
                    }
                }
                item {
                    Text(
                        stringResource(R.string.imports_transactions),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                item { FilterRow(page, filter, vm::selectFilter) }
                if (page.rows.isEmpty()) {
                    item { EmptyRows(page) }
                } else {
                    item {
                        SectionCard(contentPadding = false) {
                            page.rows.forEachIndexed { index, row ->
                                if (index > 0) RowDivider()
                                PendingRow(row)
                            }
                        }
                    }
                    if (page.pageCount > 1) item { Pager(page, vm::goToPage) }
                }
            }
            ConfirmBar(
                page = page,
                busy = busy,
                error = errors["form"],
                onCancel = { confirmCancel = true },
                onConfirm = vm::confirm,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
    if (confirmCancel) {
        ConfirmDialog(
            title = stringResource(R.string.imports_discard_title),
            text = stringResource(R.string.imports_discard_text),
            confirmLabel = stringResource(R.string.imports_discard),
            onConfirm = vm::cancel,
            onDismiss = { confirmCancel = false },
        )
    }
}

@Composable
private fun moneyText(
    minor: Long,
    currency: String,
): String {
    val hidden = LocalSession.current?.preferences?.blurAmounts == true
    return if (hidden) "$currency •••" else LocalFormats.current.money(minor, currency)
}

@Composable
private fun SummaryCard(page: ImportPendingPage) {
    val formats = LocalFormats.current
    val ibanMode = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    val iban = ibanLabel(page.account.iban, ibanMode)
    val statement = page.statement
    val period = statement?.let { formatPeriod(it.fromDate, it.toDate, formats) }
    SectionCard(
        title = page.fileName,
        subtitle =
            if (iban != null) {
                stringResource(R.string.imports_into_iban, page.account.name, iban)
            } else {
                stringResource(R.string.imports_into, page.account.name)
            },
        trailing = { Pill(formatName(page.format)) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            LabeledValue(stringResource(R.string.imports_period), period ?: stringResource(R.string.imports_unknown))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                BalanceValue(stringResource(R.string.imports_opening), statement?.openingBalance, Modifier.weight(1f))
                BalanceValue(stringResource(R.string.imports_closing), statement?.closingBalance, Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CountTile(stringResource(R.string.imports_count_new), brandNew(page.counts), Modifier.weight(1f))
                if (page.counts.replacesMirror > 0) {
                    CountTile(stringResource(R.string.imports_count_mirror), page.counts.replacesMirror, Modifier.weight(1f))
                }
                CountTile(stringResource(R.string.imports_count_duplicates), page.counts.duplicate, Modifier.weight(1f))
                CountTile(stringResource(R.string.imports_count_total), page.counts.total, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun LabeledValue(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun BalanceValue(
    label: String,
    balance: ImportBalance?,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (balance == null) {
            Text(stringResource(R.string.imports_not_in_file), style = MaterialTheme.typography.bodyLarge)
        } else {
            AmountText(balance.amount, balance.currency, style = MaterialTheme.typography.bodyLarge)
            Text(
                LocalFormats.current.date(balance.date),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun CountTile(
    label: String,
    count: Int,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
    ) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(count.toString(), style = MaterialTheme.typography.titleMedium)
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

@Composable
private fun AlreadyImported(at: Long) {
    SectionCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Outlined.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.imports_already_title), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.imports_already_text, formatDateTime(at, LocalFormats.current.locale)),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun WarningsCard(page: ImportPendingPage) {
    val count = page.warnings.size + page.balanceWarnings.size
    val formats = LocalFormats.current
    SectionCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = MaterialTheme.kept.warning)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(pluralStringResource(R.plurals.imports_warnings_title, count, count), style = MaterialTheme.typography.titleSmall)
                page.warnings.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                page.balanceWarnings.forEach { warning ->
                    Text(balanceWarningText(warning, formats.date(warning.date)), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@Composable
private fun balanceWarningText(
    warning: ImportBalanceWarning,
    date: String,
): String {
    val file = moneyText(warning.fileAmount, warning.currency)
    val ledger = moneyText(warning.ledgerAmount, warning.currency)
    return if (warning.code == "opening_mismatch") {
        stringResource(R.string.imports_balance_opening, file, date, ledger)
    } else {
        stringResource(R.string.imports_balance_closing, date, ledger, file)
    }
}

@Composable
private fun ErrorsCard(
    page: ImportPendingPage,
    onMap: () -> Unit,
) {
    SectionCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.imports_errors_title), style = MaterialTheme.typography.titleSmall)
                if (page.needsMapping) Text(stringResource(R.string.imports_needs_mapping), style = MaterialTheme.typography.bodyMedium)
                otherErrors(page.errors).forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (page.needsMapping) Button(onClick = onMap) { Text(stringResource(R.string.imports_map_columns)) }
            }
        }
    }
}

@Composable
private fun FilterRow(
    page: ImportPendingPage,
    selected: String,
    onSelect: (String) -> Unit,
) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        importFilters(page.counts).forEach { filter ->
            val name =
                stringResource(
                    when (filter.value) {
                        "new" -> R.string.imports_filter_new
                        "replaces_mirror" -> R.string.imports_filter_mirror
                        "duplicate" -> R.string.imports_filter_duplicates
                        else -> R.string.imports_filter_all
                    },
                )
            FilterChip(
                selected = selected == filter.value,
                onClick = { onSelect(filter.value) },
                label = { Text(stringResource(R.string.imports_filter_count, name, filter.count), maxLines = 1) },
            )
        }
    }
}

@Composable
private fun EmptyRows(page: ImportPendingPage) {
    val text =
        when {
            page.counts.total == 0 -> R.string.imports_rows_none
            page.filter == "new" -> R.string.imports_rows_none_new
            page.filter == "replaces_mirror" -> R.string.imports_rows_none_mirror
            else -> R.string.imports_rows_none_duplicate
        }
    Text(
        stringResource(text),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
    )
}

@Composable
private fun PendingRow(row: ImportPendingRow) {
    val formats = LocalFormats.current
    val status = ImportRowStatus.fromApi(row.status)
    val subtitle = rowSubtitle(row.tx)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(rowTitle(row.tx), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 2)
            AmountText(
                row.tx.amount,
                row.tx.currency,
                tone = AmountTone.SIGNED,
                showPlus = true,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        if (subtitle != null) {
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
        if (!row.tx.reference.isNullOrBlank()) {
            Text(row.tx.reference, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                formats.date(row.tx.bookingDate),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val (label, color) = statusStyle(status)
            Pill(stringResource(label), color = color)
        }
        val note =
            when {
                status == ImportRowStatus.REPLACES_MIRROR -> R.string.imports_status_mirror_note
                status != ImportRowStatus.NEW && row.matchedBy == "legacy_id" -> R.string.imports_status_legacy_note
                else -> null
            }
        if (note != null) {
            Text(stringResource(note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun statusStyle(status: ImportRowStatus): Pair<Int, Color> =
    when (status) {
        ImportRowStatus.NEW -> R.string.imports_status_new to MaterialTheme.kept.positive
        ImportRowStatus.REPLACES_MIRROR -> R.string.imports_status_mirror to MaterialTheme.colorScheme.primary
        ImportRowStatus.DUPLICATE -> R.string.imports_status_duplicate to MaterialTheme.colorScheme.onSurfaceVariant
        ImportRowStatus.DUPLICATE_IN_FILE -> R.string.imports_status_duplicate_in_file to MaterialTheme.colorScheme.onSurfaceVariant
    }

@Composable
private fun Pager(
    page: ImportPendingPage,
    onPage: (Int) -> Unit,
) {
    val (first, last) = rowRange(page)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { onPage(page.page - 1) }, enabled = page.page > 1) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(stringResource(R.string.imports_previous), modifier = Modifier.padding(start = 4.dp))
        }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.imports_pager_range, first, last, page.filteredTotal), style = MaterialTheme.typography.bodySmall)
            Text(
                stringResource(R.string.imports_pager_page, page.page, page.pageCount),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = { onPage(page.page + 1) }, enabled = page.page < page.pageCount) {
            Text(stringResource(R.string.imports_next), modifier = Modifier.padding(end = 4.dp))
            Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun ConfirmBar(
    page: ImportPendingPage,
    busy: Boolean,
    error: String?,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = confirmState(page)
    Surface(modifier.fillMaxWidth(), tonalElevation = 3.dp, shadowElevation = 3.dp) {
        Column(
            Modifier.navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!error.isNullOrBlank()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = onCancel, enabled = !busy) { Text(stringResource(R.string.cancel)) }
                Button(onClick = onConfirm, enabled = !busy && state is ConfirmState.Import, modifier = Modifier.weight(1f)) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    } else {
                        Text(
                            when (state) {
                                is ConfirmState.Import -> pluralStringResource(R.plurals.imports_confirm, state.count, state.count)
                                ConfirmState.NothingNew -> stringResource(R.string.imports_confirm_nothing)
                                ConfirmState.Blocked -> stringResource(R.string.imports_confirm_blocked)
                            },
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}
