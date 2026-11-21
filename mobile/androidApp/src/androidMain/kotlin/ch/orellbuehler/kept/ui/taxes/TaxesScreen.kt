package ch.orellbuehler.kept.ui.taxes

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Balance
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.TaxYearSummary
import ch.orellbuehler.kept.model.TaxesPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept

class TaxesViewModel(
    sdk: KeptSdk,
) : PageViewModel<TaxesPage>(sdk, { it.load("taxes") }) {
    fun create(values: TaxYearFormValues) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        submit("taxes", "create", form)
    }
}

/** The tax years, each compared with what the tax office counted. */
@Composable
fun TaxesScreen(nav: Navigator) {
    val vm = keptViewModel { TaxesViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val page = (state as? Load.Ready)?.value
    var formOpen by rememberSaveable { mutableStateOf(false) }
    var formKey by rememberSaveable { mutableIntStateOf(0) }

    fun openForm() {
        vm.clearFormErrors()
        formKey++
        formOpen = true
    }

    PageScaffold(
        title = stringResource(R.string.more_taxes),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = {
            when (it) {
                UiEvent.Saved -> formOpen = false
                is UiEvent.Navigate -> nav.openWebPath(it.webPath)
                else -> Unit
            }
        },
        floatingActionButton = {
            if (page != null) {
                FloatingActionButton(onClick = ::openForm) {
                    Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.taxes_add_year))
                }
            }
        },
    ) { data, padding ->
        if (data.years.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.Balance,
                title = stringResource(R.string.taxes_empty_title),
                text = stringResource(R.string.taxes_empty_text),
                action = stringResource(R.string.taxes_add_year),
                onAction = ::openForm,
            )
        } else {
            ScrollColumn(padding) {
                Text(
                    stringResource(R.string.taxes_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                data.years.forEach { year -> YearCard(year) { nav.open(Routes.taxYear(year.year)) } }
            }
        }
    }

    if (page != null && formOpen) {
        TaxYearFormSheet(
            key = formKey,
            title = stringResource(R.string.taxes_add_year),
            submitLabel = stringResource(R.string.taxes_add_year_submit),
            initial = TaxYearFormValues.forNewYear(page.defaultYear, page.defaultCurrency),
            yearEditable = true,
            busy = busy,
            errors = errors,
            onDismiss = { formOpen = false },
            onSubmit = vm::create,
        )
    }
}

@Composable
private fun YearCard(
    year: TaxYearSummary,
    onClick: () -> Unit,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = year.year.toString(),
        subtitle = year.authority ?: stringResource(R.string.taxes_no_authority),
        onClick = onClick,
        trailing = { StatusPill(year) },
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Label(stringResource(R.string.taxes_paid_by_you))
                AmountText(year.balance.paidByMe, year.currency)
            }
            Column(Modifier.weight(1f)) {
                Label(stringResource(R.string.taxes_counted))
                AmountText(year.balance.creditedByOffice, year.currency)
            }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.End) {
                Label(stringResource(R.string.taxes_still_open))
                OutcomeText(year.balance, year.currency)
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 2.dp),
    )
}

@Composable
private fun StatusPill(year: TaxYearSummary) {
    when {
        year.reconciled -> Pill(stringResource(R.string.taxes_status_reconciled), color = MaterialTheme.kept.positive)
        year.discrepancies > 0 ->
            Pill(
                pluralStringResource(R.plurals.taxes_differences, year.discrepancies, year.discrepancies),
                color = MaterialTheme.colorScheme.error,
            )
        else -> Pill(stringResource(R.string.taxes_status_no_lines))
    }
}
