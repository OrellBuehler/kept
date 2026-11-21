package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.model.AccountDetailPortfolio
import ch.orellbuehler.kept.model.AccountDetailPortfolioValue
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.KeyValueRow
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SectionHeader

val PORTFOLIO_CLOSE_REASONS = listOf("age", "wef", "self_employment", "emigration", "transfer", "disability", "death", "other")

private fun closeReasonLabel(reason: String): Int =
    when (reason) {
        "age" -> R.string.accounts_close_age
        "wef" -> R.string.accounts_close_wef
        "self_employment" -> R.string.accounts_close_self_employment
        "emigration" -> R.string.accounts_close_emigration
        "transfer" -> R.string.accounts_close_transfer
        "disability" -> R.string.accounts_close_disability
        "death" -> R.string.accounts_close_death
        else -> R.string.accounts_close_other
    }

/** The portfolios of a pillar 3a account: their latest values, close and reopen, and the deposit details. */
@Composable
internal fun PortfoliosCard(
    page: AccountDetailPage,
    vm: AccountViewModel,
    onDialog: (AccountDialog) -> Unit,
) {
    val open = page.portfolios.filter { it.closedOn == null }
    val closed = page.portfolios.filter { it.closedOn != null }
    SectionCard(
        title = stringResource(R.string.accounts_portfolios),
        subtitle = stringResource(R.string.accounts_portfolios_text),
        contentPadding = false,
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (open.isNotEmpty()) {
                OutlinedButton(onClick = { onDialog(AccountDialog.PortfolioValues) }) {
                    Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.accounts_update_values), Modifier.padding(start = 4.dp))
                }
            }
            OutlinedButton(onClick = { onDialog(AccountDialog.PortfolioForm(null)) }) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.accounts_add_portfolio), Modifier.padding(start = 4.dp))
            }
        }
        if (page.portfolios.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.accounts_no_portfolios_title), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.accounts_no_portfolios_text),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        open.forEach { portfolio ->
            RowDivider()
            PortfolioRow(portfolio, page.account.currency, vm, onDialog)
        }
        if (closed.isNotEmpty()) {
            RowDivider()
            Column(Modifier.padding(horizontal = 16.dp)) { SectionHeader(stringResource(R.string.accounts_closed)) }
            closed.forEach { portfolio ->
                RowDivider()
                PortfolioRow(portfolio, page.account.currency, vm, onDialog)
            }
        }
        val deposit = page.account.depositIban
        val contract = page.account.contractNumber
        if (deposit != null || contract != null) {
            RowDivider()
            DepositDetails(deposit, contract)
        }
    }
}

@Composable
private fun PortfolioRow(
    portfolio: AccountDetailPortfolio,
    currency: String,
    vm: AccountViewModel,
    onDialog: (AccountDialog) -> Unit,
) {
    val formats = LocalFormats.current
    val context = LocalContext.current
    val copied = stringResource(R.string.accounts_reference_copied)
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, top = 10.dp, bottom = 10.dp, end = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    portfolio.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (portfolio.closedOn != null) Pill(stringResource(R.string.accounts_closed_on, formats.date(portfolio.closedOn)))
            }
            val subtitle =
                listOfNotNull(portfolio.strategy, portfolio.number?.let { stringResource(R.string.accounts_portfolio_number, it) })
                    .joinToString(" · ")
            if (subtitle.isNotBlank()) {
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            portfolio.closeReason?.let {
                Text(
                    stringResource(closeReasonLabel(it)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            portfolio.depositReference?.let { reference ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        formatReference(reference),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    IconButton(
                        onClick = {
                            copyToClipboard(context, reference, copied)
                        },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            Icons.Outlined.ContentCopy,
                            contentDescription = stringResource(R.string.accounts_copy_reference, portfolio.name),
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            if (portfolio.latestValue != null) {
                AmountText(portfolio.latestValue, currency, style = MaterialTheme.typography.titleMedium)
                portfolio.latestValueDate?.let {
                    Text(
                        stringResource(R.string.accounts_as_of, formats.date(it)),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Text(
                    stringResource(R.string.accounts_no_value_yet),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.accounts_portfolio_actions, portfolio.name))
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.accounts_value_history)) },
                    leadingIcon = { Icon(Icons.Outlined.History, contentDescription = null) },
                    onClick = {
                        menu = false
                        onDialog(AccountDialog.PortfolioHistory(portfolio))
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.edit)) },
                    leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                    onClick = {
                        menu = false
                        onDialog(AccountDialog.PortfolioForm(portfolio))
                    },
                )
                if (portfolio.closedOn != null) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.accounts_reopen)) },
                        leadingIcon = { Icon(Icons.Outlined.LockOpen, contentDescription = null) },
                        onClick = {
                            menu = false
                            vm.reopenPortfolio(portfolio.id)
                        },
                    )
                } else {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.accounts_close)) },
                        leadingIcon = { Icon(Icons.Outlined.Lock, contentDescription = null) },
                        onClick = {
                            menu = false
                            onDialog(AccountDialog.ClosePortfolio(portfolio))
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menu = false
                        onDialog(AccountDialog.DeletePortfolio(portfolio))
                    },
                )
            }
        }
    }
}

@Composable
private fun DepositDetails(
    depositIban: String?,
    contractNumber: String?,
) {
    val mode = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    val context = LocalContext.current
    val copied = stringResource(R.string.accounts_iban_copied)
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.accounts_deposit_details), style = MaterialTheme.typography.titleSmall)
        Text(
            stringResource(R.string.accounts_deposit_details_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (contractNumber != null) KeyValueRow(stringResource(R.string.accounts_field_contract), contractNumber)
        if (depositIban != null) {
            val shown = displayIban(depositIban, mode)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    KeyValueRow(
                        stringResource(if (isQrIban(depositIban)) R.string.accounts_qr_iban else R.string.accounts_field_iban),
                        shown ?: stringResource(R.string.accounts_iban_hidden),
                    )
                }
                IconButton(
                    onClick = {
                        copyToClipboard(context, formatIban(depositIban), copied)
                    },
                ) {
                    Icon(
                        Icons.Outlined.ContentCopy,
                        contentDescription = stringResource(R.string.accounts_copy_iban),
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

@Composable
internal fun PortfolioFormSheet(
    portfolio: AccountDetailPortfolio?,
    qrIban: Boolean,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (PortfolioDraft) -> Unit,
) {
    var draft by remember { mutableStateOf(PortfolioDraft.from(portfolio)) }
    FormSheet(
        title = stringResource(if (portfolio == null) R.string.accounts_add_portfolio else R.string.accounts_edit_portfolio),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(draft) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (portfolio == null) R.string.accounts_add_portfolio else R.string.save),
        submitEnabled = draft.name.isNotBlank(),
    ) {
        Text(
            stringResource(R.string.accounts_portfolio_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FormTextField(
            label = stringResource(R.string.accounts_field_name),
            value = draft.name,
            onValueChange = { draft = draft.copy(name = it) },
            error = errors["name"],
            placeholder = stringResource(R.string.accounts_portfolio_name_placeholder),
            capitalization = KeyboardCapitalization.Sentences,
        )
        FormTextField(
            label = stringResource(R.string.accounts_portfolio_strategy),
            value = draft.strategy,
            onValueChange = { draft = draft.copy(strategy = it) },
            error = errors["strategy"],
            capitalization = KeyboardCapitalization.Sentences,
        )
        FormTextField(
            label = stringResource(R.string.accounts_portfolio_number_optional),
            value = draft.number,
            onValueChange = { draft = draft.copy(number = it) },
            error = errors["number"],
            hint = stringResource(R.string.accounts_portfolio_number_hint),
        )
        FormTextField(
            label = stringResource(if (qrIban) R.string.accounts_portfolio_reference_qr else R.string.accounts_portfolio_reference),
            value = draft.depositReference,
            onValueChange = { draft = draft.copy(depositReference = it) },
            error = errors["depositReference"],
            hint = stringResource(R.string.accounts_portfolio_reference_hint),
            placeholder =
                stringResource(
                    if (qrIban) R.string.accounts_portfolio_reference_qr_placeholder else R.string.accounts_portfolio_reference_placeholder,
                ),
            capitalization = KeyboardCapitalization.Characters,
        )
        DateField(
            label = stringResource(R.string.accounts_portfolio_opened),
            value = draft.openedOn,
            onValueChange = { draft = draft.copy(openedOn = it) },
            error = errors["openedOn"],
            optional = true,
        )
        FormTextField(
            label = stringResource(R.string.accounts_portfolio_sort),
            value = draft.sortOrder,
            onValueChange = { draft = draft.copy(sortOrder = it.filter { c -> c.isDigit() || c == '-' }.take(7)) },
            error = errors["sortOrder"],
            hint = stringResource(R.string.accounts_portfolio_sort_hint),
            keyboardType = KeyboardType.Number,
        )
    }
}

/** The current value of each open portfolio on one day, as on the provider's statement. */
@Composable
internal fun PortfolioValuesSheet(
    portfolios: List<AccountDetailPortfolio>,
    currency: String,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (PortfolioValuesDraft) -> Unit,
) {
    val today = serverToday(LocalSession.current?.today)
    val open = portfolios.filter { it.closedOn == null }
    var draft by remember { mutableStateOf(PortfolioValuesDraft.from(open, currency, today)) }
    FormSheet(
        title = stringResource(R.string.accounts_update_values),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(draft) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(R.string.accounts_save_values),
    ) {
        Text(
            stringResource(R.string.accounts_values_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DateField(
            label = stringResource(R.string.accounts_date),
            value = draft.date,
            onValueChange = { draft = draft.copy(date = it) },
            error = errors["date"],
        )
        open.forEach { portfolio ->
            AmountField(
                label = listOfNotNull(portfolio.name, portfolio.strategy).joinToString(" · "),
                value = draft.values[portfolio.id].orEmpty(),
                onValueChange = { draft = draft.copy(values = draft.values + (portfolio.id to it)) },
                error = errors["value:${portfolio.id}"],
                currency = currency,
            )
        }
        FormTextField(
            label = stringResource(R.string.accounts_note_optional),
            value = draft.note,
            onValueChange = { draft = draft.copy(note = it) },
            error = errors["note"],
            capitalization = KeyboardCapitalization.Sentences,
        )
    }
}

/** The value history of one portfolio, newest first, with delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PortfolioHistorySheet(
    portfolio: AccountDetailPortfolio,
    values: List<AccountDetailPortfolioValue>,
    currency: String,
    onDismiss: () -> Unit,
    onDelete: (AccountDetailPortfolioValue) -> Unit,
) {
    val formats = LocalFormats.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(portfolio.name, style = MaterialTheme.typography.titleLarge)
            Text(
                stringResource(R.string.accounts_value_history_text),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (values.isEmpty()) Text(stringResource(R.string.accounts_no_values), style = MaterialTheme.typography.bodyMedium)
            values.forEach { value ->
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(formats.date(value.date), style = MaterialTheme.typography.bodyLarge)
                        if (!value.note.isNullOrBlank()) {
                            Text(
                                value.note,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                            )
                        }
                    }
                    AmountText(value.amount, currency, style = MaterialTheme.typography.bodyLarge)
                    IconButton(onClick = { onDelete(value) }) {
                        Icon(
                            Icons.Outlined.Delete,
                            contentDescription = stringResource(R.string.accounts_delete_value, formats.date(value.date)),
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun ClosePortfolioSheet(
    portfolio: AccountDetailPortfolio,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (closedOn: String, reason: String) -> Unit,
) {
    val today = serverToday(LocalSession.current?.today)
    var closedOn by remember { mutableStateOf(today) }
    var reason by remember { mutableStateOf("age") }
    FormSheet(
        title = stringResource(R.string.accounts_close_portfolio, portfolio.name),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(closedOn, reason) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(R.string.accounts_close_portfolio_action),
    ) {
        Text(
            stringResource(R.string.accounts_close_portfolio_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DateField(label = stringResource(R.string.accounts_closed_on_label), value = closedOn, onValueChange = {
            closedOn = it
        }, error = errors["closedOn"])
        ChoiceField(
            label = stringResource(R.string.accounts_close_reason),
            options = PORTFOLIO_CLOSE_REASONS.map { Choice(it, stringResource(closeReasonLabel(it))) },
            selected = reason,
            onSelect = { reason = it },
            error = errors["closeReason"],
        )
    }
}
