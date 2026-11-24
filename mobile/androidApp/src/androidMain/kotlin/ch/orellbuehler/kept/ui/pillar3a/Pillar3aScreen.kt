package ch.orellbuehler.kept.ui.pillar3a

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Savings
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptErrorKind
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.Pillar3aBuyInCheck
import ch.orellbuehler.kept.model.Pillar3aContribution
import ch.orellbuehler.kept.model.Pillar3aGap
import ch.orellbuehler.kept.model.Pillar3aOrphan
import ch.orellbuehler.kept.model.Pillar3aPage
import ch.orellbuehler.kept.model.Pillar3aPortfolio
import ch.orellbuehler.kept.model.Pillar3aSaveResult
import ch.orellbuehler.kept.model.Pillar3aYear
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
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
import ch.orellbuehler.kept.ui.components.ProgressBar
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerializationException

class Pillar3aViewModel(
    sdk: KeptSdk,
) : PageViewModel<Pillar3aPage>(sdk, { it.load("pillar-3a") }) {
    private val path = "pillar-3a"

    private val mutableSaved = MutableStateFlow(0)

    /** Counts saved forms: a change closes the sheet that is open. */
    val saved: StateFlow<Int> = mutableSaved.asStateFlow()

    private fun form(fields: List<Pair<String, String>>): FormBody = FormBody().also { body -> fields.forEach { (k, v) -> body.set(k, v) } }

    fun setYear(
        year: Int,
        values: YearFormValues,
    ) = submit(path, "setYear", form(values.fields(year))) { mutableSaved.value++ }

    fun saveContribution(
        editing: Pillar3aContribution?,
        values: ContributionFormValues,
    ) {
        submit(
            path,
            if (editing == null) "addContribution" else "updateContribution",
            form(values.fields(editing)),
        ) { result ->
            runCatching { ApiJson.decodeFromString<Pillar3aSaveResult>(result.json) }
                .getOrNull()
                ?.warnings
                ?.forEach { message(it) }
            mutableSaved.value++
        }
    }

    fun delete(contribution: Pillar3aContribution) {
        val fields = deleteFields(contribution) ?: return
        submit(path, "deleteContribution", form(fields), showRefusal = true)
    }

    fun deleteOrphan(orphan: Pillar3aOrphan) =
        submit(path, "deleteContribution", FormBody().set("contributionId", orphan.id), showRefusal = true)

    /** The live buy-in check; null when the server finds the input incomplete, an exception when the check cannot be made. */
    suspend fun checkBuyIn(query: Map<String, String>): Pillar3aBuyInCheck? =
        try {
            ApiJson.decodeFromString<Pillar3aBuyInCheck>(sdk.endpoint("pillar-3a/buy-in-check", query))
        } catch (e: KeptException) {
            if (e.kind == KeptErrorKind.REJECTED) null else throw e
        } catch (e: SerializationException) {
            throw KeptException(KeptErrorKind.SERVER, e.javaClass.simpleName)
        }
}

/** Contributions, yearly limits, buy-ins and the value of the pillar 3a portfolios. */
@Composable
fun Pillar3aScreen(nav: Navigator) {
    val vm = keptViewModel { Pillar3aViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val saved by vm.saved.collectAsStateWithLifecycle()
    val page = (state as? Load.Ready)?.value

    var yearOpen by rememberSaveable { mutableStateOf<Int?>(null) }
    var contributionOpen by rememberSaveable { mutableStateOf(false) }
    var editingKey by rememberSaveable { mutableStateOf<String?>(null) }
    var presetKind by rememberSaveable { mutableStateOf<String?>(null) }
    var formKey by rememberSaveable { mutableIntStateOf(0) }
    var deleting by remember { mutableStateOf<Pillar3aContribution?>(null) }
    var deletingOrphan by remember { mutableStateOf<Pillar3aOrphan?>(null) }

    LaunchedEffect(saved) {
        if (saved > 0) {
            yearOpen = null
            contributionOpen = false
        }
    }

    fun openContribution(
        key: String?,
        preset: String?,
    ) {
        vm.clearFormErrors()
        editingKey = key
        presetKind = preset
        formKey++
        contributionOpen = true
    }

    PageScaffold(
        title = stringResource(R.string.more_pillar3a),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { if (it is UiEvent.Navigate) nav.openWebPath(it.webPath, replace = true) },
        floatingActionButton = {
            if (page != null && page.overview.portfolios.isNotEmpty()) {
                FloatingActionButton(onClick = { openContribution(null, null) }) {
                    Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.pillar3a_add_contribution))
                }
            }
        },
    ) { data, padding ->
        if (data.accounts.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.Savings,
                title = stringResource(R.string.pillar3a_empty_title),
                text = stringResource(R.string.pillar3a_empty_text),
                action = stringResource(R.string.pillar3a_go_to_accounts),
                onAction = { nav.open(Routes.ACCOUNTS) },
            )
        } else {
            ScrollColumn(padding) {
                TotalsCard(data)
                YearsCard(data, onEdit = {
                    yearOpen = it.year
                    vm.clearFormErrors()
                })
                PortfoliosCard(data, nav)
                PerformanceCard(data)
                ContributionsCard(
                    data,
                    onAdd = { openContribution(null, null) },
                    onEdit = { openContribution(it.key, null) },
                    onBuyIn = { openContribution(it.key, "buy_in") },
                    onDelete = { deleting = it },
                )
                OrphansCard(data.overview.orphanAnnotations, onDelete = { deletingOrphan = it })
            }
        }
    }

    val year = page?.overview?.years?.firstOrNull { it.year == yearOpen }
    if (page != null && year != null) {
        YearSheet(year, busy, errors, onDismiss = { yearOpen = null }, onSubmit = { vm.setYear(year.year, it) })
    }
    if (page != null && contributionOpen) {
        val editing = page.contributions.firstOrNull { it.key == editingKey }
        ContributionSheet(
            key = formKey,
            page = page,
            editing = editing,
            presetKind = presetKind,
            vm = vm,
            busy = busy,
            errors = errors,
            onDismiss = { contributionOpen = false },
            onSubmit = { vm.saveContribution(editing, it) },
        )
    }
    deleting?.let { contribution ->
        val reset = contribution.isDetected
        ConfirmDialog(
            title = stringResource(if (reset) R.string.pillar3a_reset_title else R.string.pillar3a_delete_title),
            text = stringResource(if (reset) R.string.pillar3a_reset_text else R.string.pillar3a_delete_text),
            confirmLabel = stringResource(if (reset) R.string.pillar3a_reset else R.string.delete),
            destructive = !reset,
            onConfirm = { vm.delete(contribution) },
            onDismiss = { deleting = null },
        )
    }
    deletingOrphan?.let { orphan ->
        ConfirmDialog(
            title = stringResource(R.string.pillar3a_orphan_delete_title),
            text = stringResource(R.string.pillar3a_orphan_delete_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = { vm.deleteOrphan(orphan) },
            onDismiss = { deletingOrphan = null },
        )
    }
}

@Composable
private fun Hint(
    text: String,
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(text, modifier, style = MaterialTheme.typography.bodySmall, color = color)
}

@Composable
private fun Figure(
    label: String,
    modifier: Modifier = Modifier,
    value: @Composable () -> Unit,
) {
    Column(modifier) {
        Hint(label)
        value()
    }
}

@Composable
private fun TotalsCard(page: Pillar3aPage) {
    val totals = page.overview.totals
    SectionCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Figure(stringResource(R.string.pillar3a_value), Modifier.weight(1f)) {
                AmountText(totals.value, PILLAR_3A_CURRENCY, style = MaterialTheme.typography.titleMedium)
            }
            Figure(stringResource(R.string.pillar3a_contributed), Modifier.weight(1f)) {
                AmountText(totals.contributed, PILLAR_3A_CURRENCY, style = MaterialTheme.typography.titleMedium)
            }
            Figure(stringResource(R.string.pillar3a_gain), Modifier.weight(1f)) {
                AmountText(totals.gain, PILLAR_3A_CURRENCY, tone = AmountTone.SIGNED, style = MaterialTheme.typography.titleMedium)
            }
        }
        Hint(stringResource(R.string.pillar3a_locked_hint), Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun deductionLabel(deduction: String): String =
    stringResource(
        when (deduction) {
            "large" -> R.string.pillar3a_deduction_large
            "none" -> R.string.pillar3a_deduction_none
            else -> R.string.pillar3a_deduction_small
        },
    )

@Composable
private fun YearsCard(
    page: Pillar3aPage,
    onEdit: (Pillar3aYear) -> Unit,
) {
    val thisYear = page.today.take(4).toIntOrNull() ?: 0
    SectionCard(
        title = stringResource(R.string.pillar3a_years),
        subtitle = stringResource(R.string.pillar3a_years_hint),
        contentPadding = false,
    ) {
        if (page.overview.years.isEmpty()) {
            Column(Modifier.padding(16.dp)) {
                Text(stringResource(R.string.pillar3a_no_years_title), style = MaterialTheme.typography.titleSmall)
                Hint(stringResource(R.string.pillar3a_no_years_text))
            }
        } else {
            page.overview.years.forEachIndexed { index, row ->
                if (index > 0) RowDivider()
                YearRow(row, thisYear, onEdit = { onEdit(row) })
            }
        }
    }
}

@Composable
private fun YearRow(
    row: Pillar3aYear,
    thisYear: Int,
    onEdit: () -> Unit,
) {
    val currency = PILLAR_3A_CURRENCY
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(row.year.toString(), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            if (row.closedBy != null) {
                Pill(stringResource(R.string.pillar3a_closed_by_buy_in), color = MaterialTheme.kept.positive)
            } else if (row.buyInEligible) {
                Pill(stringResource(R.string.pillar3a_open_gap))
            }
            if (row.overLimit > 0) Pill(stringResource(R.string.pillar3a_over_limit), color = MaterialTheme.colorScheme.error)
        }
        ProgressBar(
            limitFraction(row),
            color = if (row.overLimit > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        )
        val formats = LocalFormats.current
        Hint(stringResource(R.string.pillar3a_paid_of, formats.money(row.ordinary, currency), formats.money(row.limit, currency)))
        if (row.limitUnconfirmed) {
            Hint(
                stringResource(
                    if (row.deduction == "large" && row.earnedIncome == null) {
                        R.string.pillar3a_limit_hint_income
                    } else {
                        R.string.pillar3a_limit_hint_estimate
                    },
                ),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Figure(stringResource(R.string.pillar3a_ordinary), Modifier.weight(1f)) { AmountText(row.ordinary, currency) }
            Figure(stringResource(R.string.pillar3a_buy_in), Modifier.weight(1f)) { AmountText(row.buyIn, currency) }
            Figure(stringResource(if (row.year < thisYear) R.string.pillar3a_gap else R.string.pillar3a_room_left), Modifier.weight(1f)) {
                if (row.closedBy != null) {
                    Text(stringResource(R.string.pillar3a_closed), color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    AmountText(row.gap, currency)
                }
            }
        }
        if (row.overLimit > 0) {
            Text(
                stringResource(R.string.pillar3a_over_limit_text, formats.money(row.overLimit, currency)),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Hint(
                deductionLabel(row.deduction) + if (row.settingInherited) "\n" + stringResource(R.string.pillar3a_inherited) else "",
                Modifier.weight(1f),
            )
            OutlinedButton(onClick = onEdit) { Text(stringResource(R.string.pillar3a_edit_deduction)) }
        }
    }
}

@Composable
private fun YearSheet(
    row: Pillar3aYear,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (YearFormValues) -> Unit,
) {
    val initial = remember(row.year) { YearFormValues.of(row) }
    var deduction by rememberSaveable(row.year) { mutableStateOf(initial.deduction) }
    var income by rememberSaveable(row.year) { mutableStateOf(initial.earnedIncome) }
    FormSheet(
        title = stringResource(R.string.pillar3a_year_title, row.year),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(YearFormValues(deduction, income)) },
        busy = busy,
        error = errors["form"] ?: errors["year"],
    ) {
        ChoiceField(
            stringResource(R.string.pillar3a_deduction),
            deductions.map { Choice(it, deductionLabel(it)) },
            deduction,
            { deduction = it },
            error = errors["deduction"],
        )
        if (deduction == "large") {
            AmountField(
                stringResource(R.string.pillar3a_earned_income),
                income,
                { income = it },
                error = errors["earnedIncome"],
            )
        }
    }
}

@Composable
private fun PortfoliosCard(
    page: Pillar3aPage,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = stringResource(R.string.pillar3a_portfolios),
        subtitle = stringResource(R.string.pillar3a_portfolios_hint),
        contentPadding = false,
    ) {
        val portfolios = page.overview.portfolios
        if (portfolios.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.pillar3a_no_portfolios_title), style = MaterialTheme.typography.titleSmall)
                Hint(stringResource(R.string.pillar3a_no_portfolios_text))
                page.accounts.forEach { account ->
                    OutlinedButton(onClick = { nav.open(Routes.account(account.id)) }) { Text(account.name) }
                }
            }
        } else {
            orderedPortfolios(portfolios).forEachIndexed { index, portfolio ->
                if (index > 0) RowDivider()
                ListRow(
                    title = portfolio.name,
                    subtitle = portfolioSubtitle(portfolio, formats::date),
                    onClick = { nav.open(Routes.account(portfolio.accountId)) },
                    showChevron = true,
                    trailing = {
                        if (portfolio.latestValue != null) {
                            AmountText(portfolio.latestValue, PILLAR_3A_CURRENCY)
                            portfolio.latestValueDate?.let { Hint(stringResource(R.string.pillar3a_as_of, formats.date(it))) }
                        } else {
                            Hint(stringResource(R.string.pillar3a_no_value))
                        }
                        Hint(stringResource(R.string.pillar3a_contributed) + " " + formats.money(portfolio.contributed, PILLAR_3A_CURRENCY))
                        if (portfolio.reportedGain != null) {
                            GainRow(stringResource(R.string.pillar3a_reported_gain), portfolio.reportedGain)
                        } else if (portfolio.gain != null) {
                            GainRow(stringResource(R.string.pillar3a_gain), portfolio.gain)
                        }
                        portfolio.returnBps?.let { Hint(stringResource(R.string.pillar3a_return) + " " + formats.signedPercent(it)) }
                    },
                )
            }
        }
    }
}

@Composable
private fun GainRow(
    label: String,
    gain: Long,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Hint(label)
        AmountText(gain, PILLAR_3A_CURRENCY, tone = AmountTone.SIGNED, showPlus = true, style = MaterialTheme.typography.bodySmall)
    }
}

/** The reported return of each portfolio: its latest figure, and its course when it was reported on two dates or more. */
@Composable
private fun PerformanceCard(page: Pillar3aPage) {
    val formats = LocalFormats.current
    val rows = performanceRows(page.overview.portfolios, page.performance)
    if (rows.isEmpty()) return
    SectionCard(
        title = stringResource(R.string.pillar3a_performance),
        subtitle = stringResource(R.string.pillar3a_performance_hint),
        contentPadding = false,
    ) {
        rows.forEachIndexed { index, row ->
            if (index > 0) RowDivider()
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(row.portfolio.name, style = MaterialTheme.typography.bodyLarge)
                        row.portfolio.strategy?.let { Hint(it) }
                        Hint(stringResource(R.string.pillar3a_as_of, formats.date(row.last.date)))
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(formats.signedPercent(row.last.gainBps), style = MaterialTheme.typography.titleMedium)
                        row.last.gain?.let {
                            AmountText(
                                it,
                                PILLAR_3A_CURRENCY,
                                tone = AmountTone.SIGNED,
                                showPlus = true,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
                if (row.points.size >= 2) LineChart(row.points.map { it.gainBps.toLong() }, height = 64.dp)
            }
        }
    }
}

@Composable
private fun portfolioSubtitle(
    portfolio: Pillar3aPortfolio,
    date: (String?) -> String,
): String =
    listOfNotNull(
        portfolio.accountName,
        portfolio.strategy,
        portfolio.closedOn?.let { stringResource(R.string.pillar3a_closed_on, date(it)) },
    ).joinToString(" · ")

@Composable
private fun ContributionsCard(
    page: Pillar3aPage,
    onAdd: () -> Unit,
    onEdit: (Pillar3aContribution) -> Unit,
    onBuyIn: (Pillar3aContribution) -> Unit,
    onDelete: (Pillar3aContribution) -> Unit,
) {
    var year by rememberSaveable { mutableStateOf<Int?>(null) }
    val years = contributionYears(page.contributions)
    val visible = visibleContributions(page.contributions, year)
    SectionCard(
        title = stringResource(R.string.pillar3a_contributions),
        subtitle = stringResource(R.string.pillar3a_contributions_hint),
        contentPadding = false,
    ) {
        if (years.size > 1) {
            ChoiceField(
                stringResource(R.string.pillar3a_filter_year),
                listOf(Choice("", stringResource(R.string.pillar3a_all_years))) + years.map { Choice(it.toString(), it.toString()) },
                year?.toString().orEmpty(),
                { year = it.toIntOrNull() },
                modifier = Modifier.padding(16.dp),
            )
        }
        when {
            page.overview.portfolios.isEmpty() ->
                Column(Modifier.padding(16.dp)) {
                    Text(
                        stringResource(R.string.pillar3a_no_portfolios_for_contributions_title),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Hint(stringResource(R.string.pillar3a_no_portfolios_for_contributions_text))
                }
            visible.isEmpty() ->
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.pillar3a_no_contributions_title), style = MaterialTheme.typography.titleSmall)
                    Hint(stringResource(R.string.pillar3a_no_contributions_text))
                    OutlinedButton(onClick = onAdd) { Text(stringResource(R.string.pillar3a_add_contribution)) }
                }
            else ->
                visible.forEachIndexed { index, contribution ->
                    if (index > 0) RowDivider()
                    ContributionRow(contribution, onEdit, onBuyIn, onDelete)
                }
        }
    }
}

@Composable
private fun ContributionRow(
    contribution: Pillar3aContribution,
    onEdit: (Pillar3aContribution) -> Unit,
    onBuyIn: (Pillar3aContribution) -> Unit,
    onDelete: (Pillar3aContribution) -> Unit,
) {
    val formats = LocalFormats.current
    var menu by remember { mutableStateOf(false) }
    Column {
        ListRow(
            title = formats.date(contribution.date),
            subtitle =
                listOfNotNull(
                    contribution.portfolioName,
                    if (contribution.dateOverridden) {
                        contribution.bookingDate?.let {
                            stringResource(
                                R.string.pillar3a_booked,
                                formats.date(it),
                            )
                        }
                    } else {
                        null
                    },
                    contribution.note,
                ).joinToString(" · "),
            trailing = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AmountText(contribution.amount, PILLAR_3A_CURRENCY, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
                    Box {
                        IconButton(onClick = { menu = true }) {
                            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.edit)) },
                                onClick = {
                                    menu = false
                                    onEdit(contribution)
                                },
                            )
                            if (!contribution.isBuyIn) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.pillar3a_mark_buy_in)) },
                                    onClick = {
                                        menu = false
                                        onBuyIn(contribution)
                                    },
                                )
                            }
                            if (!contribution.isDetected) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        menu = false
                                        onDelete(contribution)
                                    },
                                )
                            } else if (contribution.id != null) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.pillar3a_reset)) },
                                    onClick = {
                                        menu = false
                                        onDelete(contribution)
                                    },
                                )
                            }
                        }
                    }
                }
            },
        )
        Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill(stringResource(if (contribution.isDetected) R.string.pillar3a_source_detected else R.string.pillar3a_source_manual))
            if (contribution.isBuyIn) {
                Pill(
                    if (contribution.gapYears.isEmpty()) {
                        stringResource(R.string.pillar3a_buy_in_plain)
                    } else {
                        stringResource(R.string.pillar3a_buy_in_for, contribution.gapYears.joinToString(", "))
                    },
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
        contribution.lateDecemberWarning?.let {
            Hint(it, Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp), MaterialTheme.kept.warning)
        }
    }
}

@Composable
private fun OrphansCard(
    orphans: List<Pillar3aOrphan>,
    onDelete: (Pillar3aOrphan) -> Unit,
) {
    if (orphans.isEmpty()) return
    val formats = LocalFormats.current
    SectionCard(
        title = stringResource(R.string.pillar3a_orphans),
        subtitle = stringResource(R.string.pillar3a_orphans_hint),
        contentPadding = false,
    ) {
        orphans.forEachIndexed { index, orphan ->
            if (index > 0) RowDivider()
            val kind =
                if (orphan.kind == "buy_in") {
                    stringResource(
                        R.string.pillar3a_orphan_buy_in,
                        orphan.gapYears.joinToString(", ").ifEmpty { stringResource(R.string.pillar3a_orphan_no_year) },
                    )
                } else {
                    stringResource(R.string.pillar3a_ordinary)
                }
            ListRow(
                title = orphan.portfolioName,
                subtitle = formats.date(orphan.date) + " · " + kind,
                trailing = { TextButton(onClick = { onDelete(orphan) }) { Text(stringResource(R.string.delete)) } },
            )
        }
    }
}

@Composable
private fun ContributionSheet(
    key: Int,
    page: Pillar3aPage,
    editing: Pillar3aContribution?,
    presetKind: String?,
    vm: Pillar3aViewModel,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (ContributionFormValues) -> Unit,
) {
    val portfolios = page.overview.portfolios
    val initial =
        remember(key) {
            ContributionFormValues.of(editing, presetKind, portfolios.firstOrNull()?.portfolioId.orEmpty(), page.today)
        }
    var portfolioId by rememberSaveable(key) { mutableStateOf(initial.portfolioId) }
    var amount by rememberSaveable(key) { mutableStateOf(initial.amount) }
    var date by rememberSaveable(key) { mutableStateOf(initial.date) }
    var kind by rememberSaveable(key) { mutableStateOf(initial.kind) }
    var years by rememberSaveable(key) { mutableStateOf(initial.gapYears.sorted().joinToString(",")) }
    var note by rememberSaveable(key) { mutableStateOf(initial.note) }
    val selected = years.split(",").mapNotNull { it.toIntOrNull() }.toSet()
    val values = ContributionFormValues(portfolioId, amount, date, kind, selected, note)
    val detected = editing?.isDetected == true
    val candidates = gapCandidates(page.overview.gaps, editing)

    FormSheet(
        title = stringResource(if (editing == null) R.string.pillar3a_add_contribution else R.string.pillar3a_edit_contribution),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(values) },
        busy = busy,
        error = errors["form"] ?: errors["transactionId"] ?: errors["contributionId"],
        submitLabel = stringResource(if (editing == null) R.string.pillar3a_add_contribution else R.string.save),
    ) {
        Hint(stringResource(if (detected) R.string.pillar3a_form_detected else R.string.pillar3a_form_manual))
        if (detected && editing != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(editing.portfolioName, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                AmountText(editing.amount, PILLAR_3A_CURRENCY, style = MaterialTheme.typography.titleSmall)
            }
        } else {
            ChoiceField(
                stringResource(R.string.pillar3a_portfolio),
                portfolios.map { Choice(it.portfolioId, "${it.name} · ${it.accountName}") },
                portfolioId,
                { portfolioId = it },
                error = errors["portfolioId"],
            )
            AmountField(stringResource(R.string.pillar3a_amount), amount, { amount = it }, error = errors["amount"])
        }
        DateField(stringResource(R.string.pillar3a_credit_date), date, { date = it }, error = errors["date"])
        Hint(stringResource(R.string.pillar3a_credit_date_hint))
        ChoiceField(
            stringResource(R.string.pillar3a_type),
            listOf(
                Choice("ordinary", stringResource(R.string.pillar3a_ordinary)),
                Choice("buy_in", stringResource(R.string.pillar3a_buy_in)),
            ),
            kind,
            { kind = it },
            error = errors["kind"],
        )
        if (kind == "buy_in") {
            GapYearsSection(candidates, selected, errors["gapYears"]) { year, on ->
                years = (if (on) selected + year else selected - year).sorted().joinToString(",")
            }
            BuyInCheck(vm, values, editing)
        }
        FormTextField(stringResource(R.string.pillar3a_note), note, { note = it.take(1000) }, error = errors["note"])
    }
}

@Composable
private fun GapYearsSection(
    candidates: List<Pillar3aGap>,
    selected: Set<Int>,
    error: String?,
    onToggle: (Int, Boolean) -> Unit,
) {
    val formats = LocalFormats.current
    Column {
        Text(stringResource(R.string.pillar3a_gap_years), style = MaterialTheme.typography.labelLarge)
        if (candidates.isEmpty()) Hint(stringResource(R.string.pillar3a_no_gap_years))
        candidates.forEach { gap ->
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = gap.year in selected, onCheckedChange = { onToggle(gap.year, it) })
                Text(gap.year.toString())
                Hint(
                    stringResource(R.string.pillar3a_gap_amount, formats.money(gap.gap, PILLAR_3A_CURRENCY)),
                    Modifier.padding(start = 8.dp),
                )
            }
        }
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

/** The live preview of the buy-in rules, debounced like the web's. */
@Composable
private fun BuyInCheck(
    vm: Pillar3aViewModel,
    values: ContributionFormValues,
    editing: Pillar3aContribution?,
) {
    val query = buyInCheckQuery(values, editing)
    var result by remember { mutableStateOf<Pillar3aBuyInCheck?>(null) }
    var checking by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(query) {
        result = null
        failed = false
        if (query == null) return@LaunchedEffect
        delay(300)
        checking = true
        try {
            result = vm.checkBuyIn(query)
        } catch (e: KeptException) {
            failed = true
        } finally {
            checking = false
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (checking) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                Hint(stringResource(R.string.pillar3a_checking))
            }
        }
        if (failed) {
            Text(
                stringResource(R.string.pillar3a_check_failed),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        result?.errors?.forEach { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        result?.warnings?.forEach { Hint(it, color = MaterialTheme.kept.warning) }
    }
}
