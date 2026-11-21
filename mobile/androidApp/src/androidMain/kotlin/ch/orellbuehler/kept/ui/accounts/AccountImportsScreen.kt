package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Upload
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountImportImpact
import ch.orellbuehler.kept.model.AccountImportRow
import ch.orellbuehler.kept.model.AccountImportsPage
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Formats
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

@Serializable
private data class UndoResult(
    val removedTransactions: Int = 0,
)

class AccountImportsViewModel(
    sdk: KeptSdk,
    private val id: String,
) : PageViewModel<AccountImportsPage>(sdk, { it.load("accounts/$id/imports") }) {
    private val mutableUndone = MutableStateFlow<Int?>(null)

    /** How many transactions the last undo removed, until the notice is dismissed. */
    val undone: StateFlow<Int?> = mutableUndone.asStateFlow()

    fun undo(importId: String) =
        submit("accounts/$id/imports", "undo", idForm("importId" to importId), showRefusal = true) { result ->
            mutableUndone.value =
                try {
                    ApiJson.decodeFromString<UndoResult>(result.json).removedTransactions
                } catch (e: SerializationException) {
                    0
                }
        }

    fun dismissUndone() {
        mutableUndone.value = null
    }
}

/** The statements imported into an account, newest first, each with an undo. */
@Composable
fun AccountImportsScreen(
    id: String,
    nav: Navigator,
) {
    val vm = keptViewModel(key = "account-imports-$id") { AccountImportsViewModel(it, id) }
    val state by vm.state.collectAsStateWithLifecycle()
    val undone by vm.undone.collectAsStateWithLifecycle()
    var target by remember { mutableStateOf<AccountImportRow?>(null) }

    PageScaffold(
        title = stringResource(R.string.accounts_import_history),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event ->
            if (event is UiEvent.Navigate) nav.openWebPath(event.webPath, replace = true)
        },
    ) { page, padding ->
        if (page.imports.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.History,
                title = stringResource(R.string.accounts_imports_empty_title),
                text = stringResource(R.string.accounts_imports_empty_text, page.account.name),
                action = stringResource(R.string.accounts_import_statement),
                onAction = { nav.open(Routes.IMPORT) },
            )
        } else {
            LazyColumn(contentPadding = padding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item(key = "head") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(page.account.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        Button(onClick = { nav.open(Routes.IMPORT) }) {
                            Icon(Icons.Outlined.Upload, contentDescription = null, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.accounts_import_transactions), Modifier.padding(start = 6.dp))
                        }
                    }
                }
                undone?.let { removed ->
                    item(key = "undone") {
                        SectionCard(onClick = vm::dismissUndone) {
                            Text(
                                pluralStringResource(R.plurals.accounts_import_undone, removed, removed),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
                items(page.imports, key = { it.id }) { row -> ImportCard(row) { target = row } }
            }
        }
    }

    target?.let { row ->
        val page = (state as? Load.Ready)?.value
        UndoDialog(
            row = row,
            impact = page?.impacts?.get(row.id) ?: AccountImportImpact(),
            onConfirm = { vm.undo(row.id) },
            onDismiss = { target = null },
        )
    }
}

@Composable
private fun ImportCard(
    row: AccountImportRow,
    onUndo: () -> Unit,
) {
    val formats = LocalFormats.current
    var expanded by remember(row.id) { mutableStateOf(false) }
    SectionCard {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(row.fileName, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text(
                    formatDateTime(row.createdAt, formats.locale),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Pill(importFormatLabel(row.format))
        }
        Text(
            period(row.statementFrom, row.statementTo, formats),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 6.dp),
        )
        if (row.openingBalance != null || row.closingBalance != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                BalanceOrDash(row.openingBalance, row.currency)
                Text("→", color = MaterialTheme.colorScheme.onSurfaceVariant)
                BalanceOrDash(row.closingBalance, row.currency)
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                stringResource(R.string.accounts_import_counts, row.newCount, row.duplicateCount),
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = onUndo) {
                Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.accounts_undo), Modifier.padding(start = 6.dp))
            }
        }
        if (row.warnings.isNotEmpty()) {
            TextButton(onClick = { expanded = !expanded }) {
                Icon(
                    Icons.Outlined.WarningAmber,
                    contentDescription = null,
                    tint = MaterialTheme.kept.warning,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    pluralStringResource(R.plurals.accounts_import_warnings, row.warnings.size, row.warnings.size),
                    Modifier.padding(start = 6.dp),
                    color = MaterialTheme.kept.warning,
                )
            }
            if (expanded) {
                row.warnings.forEach {
                    Text(
                        "• $it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun BalanceOrDash(
    amount: Long?,
    currency: String,
) {
    if (amount != null) {
        AmountText(amount, currency, style = MaterialTheme.typography.bodyMedium)
    } else {
        Text("—", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun UndoDialog(
    row: AccountImportRow,
    impact: AccountImportImpact,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val lost = describeImpact(impact)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.accounts_undo_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(pluralStringResource(R.plurals.accounts_undo_text, row.newCount, row.newCount))
                Text(row.fileName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (lost.isNotEmpty()) {
                    Text(
                        stringResource(R.string.accounts_undo_lost),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    lost.forEach { Text("• " + impactText(it), style = MaterialTheme.typography.bodyMedium) }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onDismiss()
                    onConfirm()
                },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text(stringResource(R.string.accounts_undo_confirm)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun impactText(line: ImpactLine): String {
    val plural =
        when (line.kind) {
            ImpactKind.CATEGORIZED -> R.plurals.accounts_impact_categorized
            ImpactKind.NOTES -> R.plurals.accounts_impact_notes
            ImpactKind.TAX_YEARS -> R.plurals.accounts_impact_tax_years
            ImpactKind.DEDUCTION_YEARS -> R.plurals.accounts_impact_deduction_years
            ImpactKind.BILL_ALLOCATIONS -> R.plurals.accounts_impact_bills
            ImpactKind.PILLAR_3A -> R.plurals.accounts_impact_pillar3a
            ImpactKind.TRANSFER_LINKS -> R.plurals.accounts_impact_links
            ImpactKind.MIRRORS -> R.plurals.accounts_impact_mirrors
        }
    return pluralStringResource(plural, line.count, line.count)
}

@Composable
private fun importFormatLabel(format: String): String =
    when (format) {
        "camt053" -> "camt.053"
        "camt054" -> "camt.054"
        "mt940" -> "MT940"
        "csv" -> "CSV"
        "xlsx" -> stringResource(R.string.accounts_format_excel)
        else -> format
    }

@Composable
private fun period(
    from: String?,
    to: String?,
    formats: Formats,
): String =
    when {
        from != null && to != null -> if (from == to) formats.date(from) else "${formats.date(from)} – ${formats.date(to)}"
        from != null || to != null -> formats.date(from ?: to)
        else -> stringResource(R.string.accounts_no_period)
    }

/** The date and time of an instant in the device's zone, in the user's locale. */
fun formatDateTime(
    millis: Long,
    locale: Locale,
): String =
    Instant
        .ofEpochMilli(millis)
        .atZone(ZoneId.systemDefault())
        .format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale))
