package ch.orellbuehler.kept.ui.recurring

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.RecurringPage
import ch.orellbuehler.kept.model.RecurringSeries
import ch.orellbuehler.kept.model.RecurringTotal
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
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.theme.kept
import kotlin.math.abs

private const val PATH = "recurring"

class RecurringViewModel(
    sdk: KeptSdk,
) : PageViewModel<RecurringPage>(sdk, { it.load(PATH) }) {
    fun confirm(id: String) = submit(PATH, "confirm", idFields(id).toFormBody(), showRefusal = true)

    fun dismiss(id: String) = submit(PATH, "dismiss", idFields(id).toFormBody(), showRefusal = true)

    fun restore(id: String) = submit(PATH, "restore", idFields(id).toFormBody(), showRefusal = true)

    fun edit(
        id: String,
        name: String,
        cadence: String,
        amount: String,
    ) = submit(PATH, "edit", editFields(id, name, cadence, amount).toFormBody())
}

/** Payments and income that repeat, detected from the transactions. */
@Composable
fun RecurringScreen(nav: Navigator) {
    val vm = keptViewModel { RecurringViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<RecurringSeries?>(null) }

    PageScaffold(
        title = stringResource(R.string.recurring_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = {
            when (it) {
                UiEvent.Saved -> editing = null
                is UiEvent.Navigate -> nav.openWebPath(it.webPath, replace = true)
                is UiEvent.Message -> Unit
            }
        },
    ) { page, padding ->
        if (page.series.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.Repeat,
                title = stringResource(R.string.recurring_empty_title),
                text = stringResource(R.string.recurring_empty_text),
                modifier = Modifier.padding(padding),
            )
            return@PageScaffold
        }
        val groups = groupSeries(page.series)
        ScrollColumn(padding) {
            Text(
                stringResource(R.string.recurring_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            page.totals.forEach { TotalsCard(it) }
            SeriesCard(
                stringResource(R.string.recurring_review_title),
                stringResource(R.string.recurring_review_text),
                groups.suggested,
                busy,
                vm,
            ) {
                vm.clearFormErrors()
                editing = it
            }
            SeriesCard(stringResource(R.string.recurring_confirmed_title), null, groups.confirmed, busy, vm) {
                vm.clearFormErrors()
                editing = it
            }
            SeriesCard(stringResource(R.string.recurring_dismissed_title), null, groups.dismissed, busy, vm) {
                vm.clearFormErrors()
                editing = it
            }
        }
        editing?.let { series ->
            EditSheet(series, busy, errors, onDismiss = { editing = null }) { name, cadence, amount ->
                vm.edit(series.id, name, cadence, amount)
            }
        }
    }
}

@Composable
private fun TotalsCard(total: RecurringTotal) {
    SectionCard(title = total.currency, subtitle = stringResource(R.string.recurring_totals_text)) {
        KeyValueAmount(stringResource(R.string.recurring_monthly), total.outflowMonthly, total.currency)
        KeyValueAmount(stringResource(R.string.recurring_annual), total.outflowAnnual, total.currency)
        if (total.inflowAnnual > 0) {
            KeyValueAmount(stringResource(R.string.recurring_income_annual), total.inflowAnnual, total.currency)
        }
    }
}

@Composable
private fun KeyValueAmount(
    label: String,
    minor: Long,
    currency: String,
) {
    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            modifier = Modifier.weight(1f),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        AmountText(minor, currency, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun SeriesCard(
    title: String,
    subtitle: String?,
    series: List<RecurringSeries>,
    busy: Boolean,
    vm: RecurringViewModel,
    onEdit: (RecurringSeries) -> Unit,
) {
    if (series.isEmpty()) return
    SectionCard(title = title, subtitle = subtitle, contentPadding = false) {
        series.forEachIndexed { index, item ->
            if (index > 0) RowDivider()
            SeriesRow(item, busy, vm, onEdit)
        }
    }
}

@Composable
private fun cadenceLabel(cadence: String): String =
    when (cadence) {
        "weekly" -> stringResource(R.string.recurring_cadence_weekly)
        "monthly" -> stringResource(R.string.recurring_cadence_monthly)
        "quarterly" -> stringResource(R.string.recurring_cadence_quarterly)
        "yearly" -> stringResource(R.string.recurring_cadence_yearly)
        else -> cadence
    }

@Composable
private fun SeriesRow(
    series: RecurringSeries,
    busy: Boolean,
    vm: RecurringViewModel,
    onEdit: (RecurringSeries) -> Unit,
) {
    val formats = LocalFormats.current
    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(series.name, style = MaterialTheme.typography.bodyLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill(cadenceLabel(series.cadence))
                    if (series.overdue &&
                        series.status == "confirmed"
                    ) {
                        Pill(stringResource(R.string.recurring_overdue), color = MaterialTheme.kept.warning)
                    }
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                AmountText(series.amount, series.currency, tone = AmountTone.SIGNED)
                Text(
                    stringResource(R.string.recurring_per_year, formats.money(series.annualCost, series.currency)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        series.priceChange?.let {
            Text(
                stringResource(
                    R.string.recurring_price_changed,
                    formats.money(it.previous, series.currency),
                    formats.money(it.latest, series.currency),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.kept.negative,
            )
        }
        Text(
            stringResource(R.string.recurring_details, formats.date(series.lastDate), formats.date(series.nextExpected)) + " · " +
                pluralStringResource(R.plurals.recurring_payments, series.occurrences, series.occurrences),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (series.status) {
                "suggested" -> {
                    TextButton(onClick = { vm.confirm(series.id) }, enabled = !busy) {
                        Icon(Icons.Outlined.Check, contentDescription = null)
                        Text(stringResource(R.string.recurring_confirm), modifier = Modifier.padding(start = 4.dp))
                    }
                    TextButton(onClick = { vm.dismiss(series.id) }, enabled = !busy) {
                        Icon(Icons.Outlined.Close, contentDescription = null)
                        Text(stringResource(R.string.recurring_dismiss), modifier = Modifier.padding(start = 4.dp))
                    }
                }
                "confirmed" ->
                    TextButton(onClick = { vm.dismiss(series.id) }, enabled = !busy) {
                        Icon(Icons.Outlined.Close, contentDescription = null)
                        Text(stringResource(R.string.recurring_dismiss), modifier = Modifier.padding(start = 4.dp))
                    }
                else ->
                    TextButton(onClick = { vm.restore(series.id) }, enabled = !busy) {
                        Icon(Icons.Outlined.Restore, contentDescription = null)
                        Text(stringResource(R.string.recurring_restore), modifier = Modifier.padding(start = 4.dp))
                    }
            }
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End) {
                IconButton(onClick = { onEdit(series) }) {
                    Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.edit))
                }
            }
        }
    }
}

@Composable
private fun EditSheet(
    series: RecurringSeries,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (name: String, cadence: String, amount: String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf(series.name) }
    var cadence by rememberSaveable { mutableStateOf(series.cadence) }
    var amount by rememberSaveable { mutableStateOf(Amounts.toInput(abs(series.amount), series.currency)) }
    FormSheet(
        title = stringResource(R.string.recurring_edit_title),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(name, cadence, amount) },
        busy = busy,
        error = errors["form"],
    ) {
        Text(
            stringResource(R.string.recurring_edit_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FormTextField(
            label = stringResource(R.string.recurring_field_name),
            value = name,
            onValueChange = { name = it.take(100) },
            error = errors["name"],
        )
        ChoiceField(
            label = stringResource(R.string.recurring_field_repeats),
            options = cadences.map { Choice(it, cadenceLabel(it)) },
            selected = cadence,
            onSelect = { cadence = it },
            error = errors["cadence"],
        )
        AmountField(
            label = stringResource(R.string.recurring_field_amount),
            value = amount,
            onValueChange = { amount = it },
            error = errors["amount"],
            currency = series.currency,
        )
    }
}
