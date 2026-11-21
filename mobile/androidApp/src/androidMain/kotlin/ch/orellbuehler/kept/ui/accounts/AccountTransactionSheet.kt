package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.model.AccountDetailTx
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.KeyValueRow
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.SectionHeader
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import java.time.LocalDate

internal fun serverToday(today: String?): String = today?.takeIf { it.length == 10 } ?: LocalDate.now().toString()

/** One transaction: its details, category, tax tags and transfer link, with edit and delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TransactionSheet(
    page: AccountDetailPage,
    tx: AccountDetailTx,
    vm: AccountViewModel,
    nav: Navigator,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val formats = LocalFormats.current
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val uriHandler = LocalUriHandler.current
    val imported = tx.source == "import"
    val mirror = tx.source == "mirror"
    val locked = imported || mirror
    val currency = page.account.currency
    val links = page.transactionLinks[tx.id].orEmpty().filter { it.url.startsWith("https://") || it.url.startsWith("http://") }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.accounts_transaction), style = MaterialTheme.typography.titleLarge)
                SourcePill(tx)
                if (tx.reversal) Pill(stringResource(R.string.accounts_reversal))
            }
            Column {
                Text(
                    formats.date(tx.bookingDate),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AmountText(
                    tx.amount,
                    currency,
                    tone = AmountTone.SIGNED,
                    showPlus = true,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            links.forEach { link ->
                TextButton(onClick = { uriHandler.openUri(link.url) }) { Text(link.label.ifBlank { link.url }, maxLines = 1) }
            }
            TransactionDetails(tx)
            if (mirror) {
                Text(
                    stringResource(R.string.accounts_mirror_text, tx.mirrorOf?.accountName.orEmpty()),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (tx.mirrorOf?.noBankCounterpart == true) {
                    Text(
                        stringResource(R.string.accounts_no_counterpart_text),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.kept.warning,
                    )
                }
            } else if (imported) {
                Text(
                    stringResource(R.string.accounts_imported_text),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(onClick = onEdit, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Edit, contentDescription = null)
                Text(stringResource(if (locked) R.string.accounts_edit_note else R.string.edit), Modifier.padding(start = 8.dp))
            }

            CategoryPicker(
                categories = page.categories,
                selectedId = tx.categoryId,
                onSelect = { vm.setCategory(tx.id, it) },
                enabled = !busy,
            )
            YearTag(
                title = stringResource(R.string.accounts_tax_year),
                hint = stringResource(R.string.accounts_tax_year_hint),
                initial = tx.taxYear,
                error = errors["taxYear"],
                busy = busy,
                onSave = { vm.setTaxYear(tx.id, it) },
                openLabel = tx.taxYear?.let { stringResource(R.string.accounts_open_tax, it) },
                onOpen = {
                    tx.taxYear?.let { year ->
                        onDismiss()
                        nav.open(Routes.taxYear(year))
                    }
                },
            )
            YearTag(
                title = stringResource(R.string.accounts_deduction_year),
                hint = stringResource(R.string.accounts_deduction_year_hint),
                initial = tx.deductionYear,
                error = errors["deductionYear"],
                busy = busy,
                onSave = { vm.setDeductionYear(tx.id, it) },
            )
            TransferSection(tx, vm, nav, busy, errors["form"], onDismiss)

            if (!imported) {
                OutlinedButton(
                    onClick = onDelete,
                    modifier = Modifier.fillMaxWidth(),
                    colors =
                        androidx.compose.material3.ButtonDefaults
                            .outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Icon(Icons.Outlined.Delete, contentDescription = null)
                    Text(
                        stringResource(if (mirror) R.string.accounts_remove_mirror else R.string.accounts_delete_transaction),
                        Modifier.padding(start = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun TransactionDetails(tx: AccountDetailTx) {
    val formats = LocalFormats.current
    val ibanMode = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    var revealed by remember(tx.id) { mutableStateOf(false) }
    Column {
        tx.valueDate?.let { KeyValueRow(stringResource(R.string.accounts_value_date), formats.date(it)) }
        tx.counterpartyName?.takeIf { it.isNotBlank() }?.let { KeyValueRow(stringResource(R.string.accounts_counterparty), it) }
        val iban = tx.counterpartyIban
        if (iban != null && ibanMode != "hidden") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    KeyValueRow(
                        stringResource(R.string.accounts_field_iban),
                        if (revealed) formatIban(iban) else displayIban(iban, ibanMode).orEmpty(),
                    )
                }
                if (ibanMode == "masked") {
                    TextButton(onClick = { revealed = !revealed }) {
                        Text(stringResource(if (revealed) R.string.accounts_hide else R.string.accounts_show))
                    }
                }
            }
        }
        tx.description?.takeIf { it.isNotBlank() }?.let { KeyValueRow(stringResource(R.string.accounts_description), it) }
        tx.reference?.takeIf { it.isNotBlank() }?.let {
            KeyValueRow(stringResource(R.string.accounts_reference), if (tx.referenceType != null) "$it (${tx.referenceType})" else it)
        }
        if (tx.originalAmount != null && tx.originalCurrency != null) {
            Row(Modifier.padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    stringResource(R.string.accounts_original_amount),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                AmountText(tx.originalAmount, tx.originalCurrency, style = MaterialTheme.typography.bodyMedium)
            }
        }
        tx.note?.takeIf { it.isNotBlank() }?.let { KeyValueRow(stringResource(R.string.accounts_note), it) }
    }
}

/** A year (tax payment, deduction) typed and saved on its own; blank removes it. */
@Composable
private fun YearTag(
    title: String,
    hint: String,
    initial: Int?,
    error: String?,
    busy: Boolean,
    onSave: (String) -> Unit,
    openLabel: String? = null,
    onOpen: () -> Unit = {},
) {
    var text by remember(initial) { mutableStateOf(initial?.toString().orEmpty()) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.filter(Char::isDigit).take(4) },
                modifier = Modifier.weight(1f),
                label = { Text(title, maxLines = 1) },
                placeholder = { Text(stringResource(R.string.accounts_year_placeholder)) },
                isError = error != null,
                supportingText = { Text(error ?: hint) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            Button(
                onClick = { onSave(text) },
                enabled = !busy && text != initial?.toString().orEmpty(),
                modifier = Modifier.padding(top = 8.dp),
            ) {
                Text(stringResource(R.string.save))
            }
        }
        if (openLabel != null) TextButton(onClick = onOpen) { Text(openLabel) }
    }
}

@Composable
private fun TransferSection(
    tx: AccountDetailTx,
    vm: AccountViewModel,
    nav: Navigator,
    busy: Boolean,
    formError: String?,
    onClose: () -> Unit,
) {
    val formats = LocalFormats.current
    val transfer = tx.transfer
    val mirror = tx.source == "mirror"
    val candidates by vm.candidates.collectAsStateWithLifecycle()
    var picker by remember(tx.id) { mutableStateOf(false) }
    var confirmUnlink by remember(tx.id) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionHeader(stringResource(R.string.accounts_transfer))
        when {
            transfer != null -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        stringResource(
                            if (transfer.direction == "out") R.string.accounts_transfer_to else R.string.accounts_transfer_from,
                            transfer.peerAccountName,
                        ),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier =
                            Modifier.weight(1f, fill = false).clickable {
                                onClose()
                                nav.open(Routes.account(transfer.peerAccountId))
                            },
                        color = MaterialTheme.colorScheme.primary,
                    )
                    if (transfer.status ==
                        "needs_amount"
                    ) {
                        Pill(stringResource(R.string.accounts_needs_amount_pill), color = MaterialTheme.kept.warning)
                    }
                }
                Text(
                    stringResource(
                        when {
                            transfer.status == "needs_amount" -> R.string.accounts_transfer_needs_amount_text
                            transfer.method == "mirrored" && mirror -> R.string.accounts_transfer_mirrored_here
                            transfer.method == "mirrored" -> R.string.accounts_transfer_mirrored_there
                            transfer.method == "manual" -> R.string.accounts_transfer_manual
                            else -> R.string.accounts_transfer_paired
                        },
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!mirror) {
                    OutlinedButton(onClick = { confirmUnlink = true }, enabled = !busy) {
                        Icon(Icons.Outlined.LinkOff, contentDescription = null)
                        Text(stringResource(R.string.accounts_unlink_transfer), Modifier.padding(start = 8.dp))
                    }
                }
            }
            mirror -> Text(stringResource(R.string.accounts_mirror_no_source), style = MaterialTheme.typography.bodySmall)
            else -> {
                Text(
                    stringResource(R.string.accounts_transfer_none),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!picker) {
                    OutlinedButton(
                        onClick = {
                            picker = true
                            vm.loadCandidates(tx.id)
                        },
                    ) {
                        Icon(Icons.Outlined.Link, contentDescription = null)
                        Text(stringResource(R.string.accounts_link_transfer), Modifier.padding(start = 8.dp))
                    }
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            stringResource(R.string.accounts_pick_other_side),
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = {
                            picker = false
                            vm.clearCandidates()
                        }) { Text(stringResource(R.string.cancel)) }
                    }
                    formError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    when (val state = candidates) {
                        CandidatesState.Idle, CandidatesState.Loading ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                CircularProgressIndicator(Modifier.padding(2.dp), strokeWidth = 2.dp)
                                Text(stringResource(R.string.accounts_looking_for_matches), style = MaterialTheme.typography.bodyMedium)
                            }
                        is CandidatesState.Failed -> {
                            Text(state.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                            OutlinedButton(onClick = { vm.loadCandidates(tx.id) }) { Text(stringResource(R.string.retry)) }
                        }
                        is CandidatesState.Ready ->
                            if (state.candidates.isEmpty()) {
                                Text(
                                    stringResource(R.string.accounts_no_candidates),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            } else {
                                state.candidates.forEach { candidate ->
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .clickable(enabled = !busy) { vm.linkTransfer(tx.id, candidate.id) }
                                            .padding(vertical = 8.dp),
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                candidate.accountName,
                                                style = MaterialTheme.typography.bodyLarge,
                                                fontWeight = FontWeight.Medium,
                                            )
                                            (candidate.counterpartyName ?: candidate.description)?.let {
                                                Text(
                                                    it,
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                    maxLines = 1,
                                                )
                                            }
                                            Row(
                                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                Text(formats.date(candidate.bookingDate), style = MaterialTheme.typography.bodySmall)
                                                Text(
                                                    if (candidate.days == 0) {
                                                        stringResource(R.string.accounts_same_day)
                                                    } else {
                                                        androidx.compose.ui.res.pluralStringResource(
                                                            R.plurals.accounts_days_apart,
                                                            candidate.days,
                                                            candidate.days,
                                                        )
                                                    },
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                                if (candidate.exact) Pill(stringResource(R.string.accounts_same_amount))
                                            }
                                        }
                                        AmountText(candidate.amount, candidate.currency, tone = AmountTone.SIGNED, showPlus = true)
                                    }
                                }
                            }
                    }
                }
            }
        }
    }
    if (confirmUnlink) {
        ConfirmDialog(
            title = stringResource(R.string.accounts_unlink_title),
            text = stringResource(R.string.accounts_unlink_text),
            confirmLabel = stringResource(R.string.accounts_unlink_transfer),
            onConfirm = { vm.unlinkTransfer(tx.id) },
            onDismiss = { confirmUnlink = false },
        )
    }
}

/** The form of a manual transaction (add, edit); imported rows and mirrors only take a note. */
@Composable
internal fun TransactionFormSheet(
    tx: AccountDetailTx?,
    currency: String,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (TxDraft) -> Unit,
) {
    val today = serverToday(LocalSession.current?.today)
    var draft by remember { mutableStateOf(TxDraft.from(tx, currency, today)) }
    val noteOnly = tx != null && tx.source != "manual"
    FormSheet(
        title = stringResource(if (tx == null) R.string.accounts_add_transaction else R.string.accounts_edit_transaction),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(draft) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (tx == null) R.string.accounts_add_transaction else R.string.save),
    ) {
        if (!noteOnly) {
            DateField(
                label = stringResource(R.string.accounts_booking_date),
                value = draft.bookingDate,
                onValueChange = { draft = draft.copy(bookingDate = it) },
                error = errors["bookingDate"],
            )
            DateField(
                label = stringResource(R.string.accounts_value_date_optional),
                value = draft.valueDate,
                onValueChange = { draft = draft.copy(valueDate = it) },
                error = errors["valueDate"],
                optional = true,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = draft.outgoing,
                    onClick = { draft = draft.copy(outgoing = true) },
                    label = { Text(stringResource(R.string.accounts_direction_out)) },
                )
                FilterChip(
                    selected = !draft.outgoing,
                    onClick = { draft = draft.copy(outgoing = false) },
                    label = { Text(stringResource(R.string.accounts_direction_in)) },
                )
            }
            AmountField(
                label = stringResource(R.string.accounts_amount),
                value = draft.amount,
                onValueChange = { draft = draft.withAmountInput(it) },
                error = errors["amount"],
                currency = currency,
            )
            FormTextField(
                label = stringResource(R.string.accounts_counterparty_optional),
                value = draft.counterpartyName,
                onValueChange = { draft = draft.copy(counterpartyName = it) },
                error = errors["counterpartyName"],
                capitalization = KeyboardCapitalization.Sentences,
            )
            FormTextField(
                label = stringResource(R.string.accounts_counterparty_iban_optional),
                value = draft.counterpartyIban,
                onValueChange = { draft = draft.copy(counterpartyIban = it) },
                error = errors["counterpartyIban"],
                capitalization = KeyboardCapitalization.Characters,
            )
            FormTextField(
                label = stringResource(R.string.accounts_description_optional),
                value = draft.description,
                onValueChange = { draft = draft.copy(description = it) },
                error = errors["description"],
                capitalization = KeyboardCapitalization.Sentences,
            )
            FormTextField(
                label = stringResource(R.string.accounts_reference_optional),
                value = draft.reference,
                onValueChange = { draft = draft.copy(reference = it) },
                error = errors["reference"],
            )
        }
        FormTextField(
            label = stringResource(R.string.accounts_note_optional),
            value = draft.note,
            onValueChange = { draft = draft.copy(note = it) },
            error = errors["note"],
            singleLine = false,
            capitalization = KeyboardCapitalization.Sentences,
        )
    }
}
