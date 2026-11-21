package ch.orellbuehler.kept.ui.forecast

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ForecastAccount
import ch.orellbuehler.kept.model.ForecastAccountSettings
import ch.orellbuehler.kept.model.ForecastItem
import ch.orellbuehler.kept.model.ForecastPage
import ch.orellbuehler.kept.model.ForecastPlanned
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.LineChart
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow

private const val PATH = "forecast"

class ForecastViewModel(
    sdk: KeptSdk,
    private val days: MutableStateFlow<Int?> = MutableStateFlow(null),
) : PageViewModel<ForecastPage>(sdk, { sdk ->
        sdk.load(PATH, days.value?.let { mapOf("days" to it.toString()) } ?: emptyMap())
    }) {
    fun selectDays(value: Int) {
        if (days.value == value) return
        days.value = value
        refresh()
    }

    fun savePlanned(
        id: String?,
        fields: Map<String, String?>,
    ) = submit(PATH, if (id == null) "createPlanned" else "updatePlanned", fields.toFormBody())

    fun deletePlanned(id: String) = submit(PATH, "deletePlanned", FormBody().set("id", id), showRefusal = true)

    fun saveSettings(fields: Map<String, String?>) = submit(PATH, "saveSettings", fields.toFormBody())
}

private sealed interface ForecastSheet {
    data object Closed : ForecastSheet

    data class Planned(
        val item: ForecastPlanned?,
    ) : ForecastSheet

    data class Settings(
        val account: ForecastAccount,
    ) : ForecastSheet
}

/** Expected balances per account, what is due, and the one-off items the user planned. */
@Composable
fun ForecastScreen(nav: Navigator) {
    val vm = keptViewModel { ForecastViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf<ForecastSheet>(ForecastSheet.Closed) }
    var deleting by remember { mutableStateOf<ForecastPlanned?>(null) }

    PageScaffold(
        title = stringResource(R.string.forecast_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = {
            when (it) {
                UiEvent.Saved -> sheet = ForecastSheet.Closed
                is UiEvent.Navigate -> nav.openWebPath(it.webPath, replace = true)
                is UiEvent.Message -> Unit
            }
        },
        floatingActionButton = {
            FloatingActionButton(onClick = {
                vm.clearFormErrors()
                sheet = ForecastSheet.Planned(null)
            }) { Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.forecast_add_planned)) }
        },
    ) { page, padding ->
        val forecast = page.forecast
        val names = forecast.accounts.associate { it.accountId to it.name }
        ScrollColumn(padding) {
            Text(
                stringResource(R.string.forecast_subtitle, LocalFormats.current.date(forecast.to)),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                page.horizons.forEach { horizon ->
                    FilterChip(
                        selected = page.days == horizon,
                        onClick = { vm.selectDays(horizon) },
                        label = { Text(stringResource(R.string.forecast_horizon, horizon), maxLines = 1) },
                    )
                }
            }
            if (forecast.accounts.isEmpty()) {
                MessagePane(
                    icon = Icons.AutoMirrored.Outlined.TrendingUp,
                    title = stringResource(R.string.forecast_empty_title),
                    text = stringResource(R.string.forecast_empty_text),
                    action = stringResource(R.string.forecast_go_accounts),
                    onAction = { nav.open(Routes.ACCOUNTS) },
                )
            } else {
                WarningsCard(warnings(forecast.accounts))
                forecast.accounts.forEach { account ->
                    AccountCard(account, forecast.to) {
                        vm.clearFormErrors()
                        sheet = ForecastSheet.Settings(account)
                    }
                }
                if (forecast.unassigned.isNotEmpty()) {
                    SectionCard(
                        title = stringResource(R.string.forecast_unassigned_title),
                        subtitle = stringResource(R.string.forecast_unassigned_text),
                    ) {
                        val formats = LocalFormats.current
                        forecast.unassigned.forEach { row ->
                            Text(
                                pluralStringResource(
                                    R.plurals.forecast_unassigned_row,
                                    row.count,
                                    row.currency,
                                    row.count,
                                    formats.money(row.outflow, row.currency),
                                    formats.money(row.inflow, row.currency),
                                ),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
                UpcomingCard(page, names)
            }
            PlannedCard(
                page.planned,
                names,
                onEdit = {
                    vm.clearFormErrors()
                    sheet = ForecastSheet.Planned(it)
                },
                onDelete = { deleting = it },
            )
        }
        when (val current = sheet) {
            ForecastSheet.Closed -> Unit
            is ForecastSheet.Planned ->
                PlannedSheet(
                    item = current.item,
                    today = page.today,
                    accounts = forecast.accounts,
                    busy = busy,
                    errors = errors,
                    onDismiss = { sheet = ForecastSheet.Closed },
                    onSubmit = { vm.savePlanned(current.item?.id, it) },
                )
            is ForecastSheet.Settings ->
                SettingsSheet(
                    account = current.account,
                    settings = page.settings.firstOrNull { it.accountId == current.account.accountId },
                    busy = busy,
                    errors = errors,
                    onDismiss = { sheet = ForecastSheet.Closed },
                    onSubmit = vm::saveSettings,
                )
        }
    }

    deleting?.let { item ->
        ConfirmDialog(
            title = stringResource(R.string.forecast_delete_title, item.label),
            text = stringResource(R.string.forecast_delete_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = { vm.deletePlanned(item.id) },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun WarningsCard(accounts: List<ForecastAccount>) {
    if (accounts.isEmpty()) return
    val formats = LocalFormats.current
    SectionCard(
        title = stringResource(R.string.forecast_low_title),
        trailing = { Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = MaterialTheme.kept.negative) },
    ) {
        accounts.forEach { account ->
            val warning = account.warning ?: return@forEach
            Text(
                if (warning.negative) {
                    stringResource(
                        R.string.forecast_low_negative,
                        account.name,
                        formats.date(warning.date),
                        formats.money(warning.balance, account.currency),
                    )
                } else {
                    stringResource(
                        R.string.forecast_low_limit,
                        account.name,
                        formats.money(warning.limit, account.currency),
                        formats.date(warning.date),
                        formats.money(warning.balance, account.currency),
                    )
                },
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun AccountCard(
    account: ForecastAccount,
    to: String,
    onSettings: () -> Unit,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = account.name,
        subtitle =
            if (account.hasBalance) {
                stringResource(
                    R.string.forecast_balance_now,
                    formats.money(account.startBalance, account.currency),
                    formats.money(account.endBalance, account.currency),
                    formats.date(to),
                ) + ". " +
                    stringResource(
                        R.string.forecast_lowest,
                        formats.money(account.lowest.balance, account.currency),
                        formats.date(account.lowest.date),
                    )
            } else {
                stringResource(R.string.forecast_no_balance)
            },
        trailing = {
            IconButton(onClick = onSettings) {
                Icon(Icons.Outlined.Settings, contentDescription = stringResource(R.string.forecast_settings_for, account.name))
            }
        },
    ) {
        val values = dailyBalances(account.points)
        if (values.size >= 2) {
            val color = if (account.negativeDate != null) MaterialTheme.kept.negative else MaterialTheme.colorScheme.primary
            LineChart(values, color = color)
        }
    }
}

@Composable
private fun UpcomingCard(
    page: ForecastPage,
    names: Map<String, String>,
) {
    val formats = LocalFormats.current
    val unprojected = page.forecast.unprojectedBills.noDueDate + page.forecast.unprojectedBills.noAmount
    SectionCard(
        title = stringResource(R.string.forecast_upcoming_title),
        subtitle = stringResource(R.string.forecast_upcoming_text, page.days),
        contentPadding = false,
    ) {
        if (unprojected > 0) {
            Text(
                pluralStringResource(R.plurals.forecast_unprojected, unprojected, unprojected),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        if (page.forecast.items.isEmpty()) {
            Text(
                stringResource(R.string.forecast_upcoming_empty),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
            )
        }
        page.forecast.items.forEachIndexed { index, item ->
            if (index > 0) RowDivider()
            ListRow(
                title = item.label,
                subtitle = "${formats.date(item.date)} · ${accountName(item, names)}",
            ) {
                AmountText(item.amount, item.currency, tone = AmountTone.SIGNED)
                Pill(sourceLabel(item.source))
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}

@Composable
private fun accountName(
    item: ForecastItem,
    names: Map<String, String>,
): String =
    when {
        item.accountId == null -> stringResource(R.string.forecast_no_account)
        else -> names[item.accountId] ?: stringResource(R.string.forecast_account_fallback)
    }

@Composable
private fun sourceLabel(source: String): String =
    when (source) {
        "bill" -> stringResource(R.string.forecast_source_bill)
        "planned" -> stringResource(R.string.forecast_source_planned)
        else -> source
    }

@Composable
private fun PlannedCard(
    planned: List<ForecastPlanned>,
    names: Map<String, String>,
    onEdit: (ForecastPlanned) -> Unit,
    onDelete: (ForecastPlanned) -> Unit,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = stringResource(R.string.forecast_planned_title),
        subtitle = stringResource(R.string.forecast_planned_text),
        contentPadding = false,
    ) {
        if (planned.isEmpty()) {
            Text(
                stringResource(R.string.forecast_planned_empty),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
            )
        }
        planned.forEachIndexed { index, item ->
            if (index > 0) RowDivider()
            var menu by remember { mutableStateOf(false) }
            val account = item.accountId?.let { names[it] ?: stringResource(R.string.forecast_account_fallback) }
            ListRow(
                title = item.label,
                subtitle = "${formats.date(item.date)} · ${account ?: stringResource(R.string.forecast_no_account)}",
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AmountText(item.amount, item.currency, tone = AmountTone.SIGNED)
                    Box {
                        IconButton(onClick = { menu = true }) {
                            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.edit)) },
                                leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                                onClick = {
                                    menu = false
                                    onEdit(item)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                                leadingIcon = {
                                    Icon(
                                        Icons.Outlined.Delete,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.error,
                                    )
                                },
                                onClick = {
                                    menu = false
                                    onDelete(item)
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PlannedSheet(
    item: ForecastPlanned?,
    today: String,
    accounts: List<ForecastAccount>,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (Map<String, String?>) -> Unit,
) {
    val currencies = accounts.map { it.currency }.distinct().sorted()
    var label by rememberSaveable { mutableStateOf(item?.label.orEmpty()) }
    var date by rememberSaveable { mutableStateOf(item?.date ?: today) }
    var direction by rememberSaveable { mutableStateOf(item?.let { plannedDirection(it.amount) } ?: "expense") }
    var accountId by rememberSaveable { mutableStateOf(item?.accountId.orEmpty()) }
    var amount by rememberSaveable { mutableStateOf(item?.let { Amounts.toInput(kotlin.math.abs(it.amount), it.currency) }.orEmpty()) }
    var currency by rememberSaveable { mutableStateOf(item?.currency ?: currencies.firstOrNull().orEmpty()) }
    FormSheet(
        title = stringResource(if (item == null) R.string.forecast_add_planned else R.string.forecast_planned_edit_title),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(plannedFields(item?.id, label, date, direction, amount, accountId, currency)) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (item == null) R.string.add else R.string.save),
    ) {
        Text(
            stringResource(R.string.forecast_planned_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FormTextField(
            label = stringResource(R.string.forecast_field_description),
            value = label,
            onValueChange = { label = it.take(80) },
            error = errors["label"],
            capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
        )
        DateField(
            label = stringResource(R.string.forecast_field_date),
            value = date,
            onValueChange = { date = it },
            error = errors["date"],
        )
        ChoiceField(
            label = stringResource(R.string.forecast_field_type),
            options =
                listOf(
                    Choice("expense", stringResource(R.string.forecast_type_expense)),
                    Choice("income", stringResource(R.string.forecast_type_income)),
                ),
            selected = direction,
            onSelect = { direction = it },
            error = errors["direction"],
        )
        ChoiceField(
            label = stringResource(R.string.forecast_field_account),
            options =
                listOf(Choice("", stringResource(R.string.forecast_no_account))) +
                    accounts.map { Choice(it.accountId, "${it.name} (${it.currency})") },
            selected = accountId,
            onSelect = { accountId = it },
            error = errors["accountId"],
        )
        AmountField(
            label = stringResource(R.string.forecast_field_amount),
            value = amount,
            onValueChange = { amount = it },
            error = errors["amount"],
        )
        FormTextField(
            label = stringResource(R.string.forecast_field_currency),
            value = currency,
            onValueChange = { currency = it.uppercase().take(3) },
            error = errors["currency"],
            enabled = accountId.isEmpty(),
        )
    }
}

@Composable
private fun SettingsSheet(
    account: ForecastAccount,
    settings: ForecastAccountSettings?,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (Map<String, String?>) -> Unit,
) {
    var threshold by rememberSaveable { mutableStateOf(settings?.threshold?.let { Amounts.toInput(it, account.currency) }.orEmpty()) }
    var defaultPayment by rememberSaveable { mutableStateOf(settings?.defaultPayment == true) }
    FormSheet(
        title = stringResource(R.string.forecast_settings_for, account.name),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(settingsFields(account.accountId, threshold, defaultPayment)) },
        busy = busy,
        error = errors["form"],
    ) {
        Text(
            stringResource(R.string.forecast_settings_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        AmountField(
            label = stringResource(R.string.forecast_settings_threshold, account.currency),
            value = threshold,
            onValueChange = { threshold = it },
            error = errors["threshold"],
        )
        SwitchRow(
            title = stringResource(R.string.forecast_settings_default, account.currency),
            checked = defaultPayment,
            onCheckedChange = { defaultPayment = it },
        )
    }
}
