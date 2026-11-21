package ch.orellbuehler.kept.ui.taxes

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Undo
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.TaxCredit
import ch.orellbuehler.kept.model.TaxDeductionLine
import ch.orellbuehler.kept.model.TaxDeductionMapping
import ch.orellbuehler.kept.model.TaxPayment
import ch.orellbuehler.kept.model.TaxRow
import ch.orellbuehler.kept.model.TaxYearPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.KeyValueRow
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept

class TaxYearViewModel(
    sdk: KeptSdk,
    private val year: String,
) : PageViewModel<TaxYearPage>(sdk, { it.load("taxes/$year") }) {
    private val path = "taxes/$year"

    private fun form(fields: List<Pair<String, String>>): FormBody = FormBody().also { body -> fields.forEach { (k, v) -> body.set(k, v) } }

    fun saveDetails(values: TaxYearFormValues) = submit(path, "saveDetails", form(values.fields()))

    fun deleteYear() = submit(path, "deleteYear", showRefusal = true, reload = false)

    fun addCredit(values: CreditFormValues) = submit(path, "addCredit", form(values.fields()))

    fun deleteCredit(id: String) = submit(path, "deleteCredit", FormBody().set("creditId", id), showRefusal = true)

    fun tag(transactionId: String) = submit(path, "tag", FormBody().set("transactionId", transactionId), showRefusal = true)

    fun untag(transactionId: String) = submit(path, "untag", FormBody().set("transactionId", transactionId), showRefusal = true)

    fun setDeduction(
        categoryId: String,
        type: String,
    ) = submit(path, "setDeduction", FormBody().set("categoryId", categoryId).set("deductionType", type), showRefusal = true)

    fun exclude(transactionId: String) =
        submit(path, "excludeDeduction", FormBody().set("transactionId", transactionId), showRefusal = true)

    fun include(transactionId: String) =
        submit(path, "includeDeduction", FormBody().set("transactionId", transactionId), showRefusal = true)

    fun undoMoves() = submit(path, "undoDeductionMoves", showRefusal = true)

    fun dismissMoves() = submit(path, "dismissDeductionMoves", showRefusal = true)
}

/** One tax year: what you paid against what the tax office counted, and the deductions. */
@Composable
fun TaxYearScreen(
    year: String,
    nav: Navigator,
) {
    val vm = keptViewModel(key = "tax-$year") { TaxYearViewModel(it, year) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val page = (state as? Load.Ready)?.value

    var tab by rememberSaveable { mutableIntStateOf(0) }
    var detailsOpen by rememberSaveable { mutableStateOf(false) }
    var creditOpen by rememberSaveable { mutableStateOf(false) }
    var formKey by rememberSaveable { mutableIntStateOf(0) }
    var deleteYearOpen by rememberSaveable { mutableStateOf(false) }
    var deletingCredit by remember { mutableStateOf<TaxCredit?>(null) }
    var menu by remember { mutableStateOf(false) }

    fun openDetails() {
        vm.clearFormErrors()
        formKey++
        detailsOpen = true
    }

    fun openCredit() {
        vm.clearFormErrors()
        formKey++
        creditOpen = true
    }

    PageScaffold(
        title = stringResource(R.string.taxes_year_title, year.toIntOrNull() ?: 0),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = {
            when (it) {
                UiEvent.Saved -> {
                    detailsOpen = false
                    creditOpen = false
                }
                is UiEvent.Navigate -> nav.openWebPath(it.webPath, replace = true)
                else -> Unit
            }
        },
        actions = {
            if (page != null) {
                IconButton(onClick = { menu = true }) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.taxes_pdf_report)) },
                        onClick = {
                            menu = false
                            nav.openInBrowser("reports/tax?year=$year")
                        },
                    )
                }
            }
        },
    ) { data, padding ->
        Column {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.taxes_tab_reconciliation)) })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.taxes_tab_deductions)) })
            }
            ScrollColumn(padding) {
                if (data.deductionMoves >
                    0
                ) {
                    MovesCard(data.deductionMoves, busy, onReview = { tab = 1 }, onUndo = vm::undoMoves, onDismiss = vm::dismissMoves)
                }
                if (tab == 0) {
                    ReconciliationTab(
                        data,
                        onTag = vm::tag,
                        onUntag = vm::untag,
                        onDeleteCredit = { deletingCredit = it },
                        onAddCredit = ::openCredit,
                        onEditDetails = ::openDetails,
                        onDeleteYear = { deleteYearOpen = true },
                        nav = nav,
                    )
                } else {
                    DeductionsTab(data, vm, nav)
                }
            }
        }
    }

    if (page != null && detailsOpen) {
        TaxYearFormSheet(
            key = formKey,
            title = stringResource(R.string.taxes_details),
            submitLabel = stringResource(R.string.taxes_save_details),
            initial = TaxYearFormValues.of(page.reconciliation.year),
            yearEditable = false,
            busy = busy,
            errors = errors,
            onDismiss = { detailsOpen = false },
            onSubmit = vm::saveDetails,
        )
    }
    if (page != null && creditOpen) {
        CreditSheet(
            key = formKey,
            busy = busy,
            errors = errors,
            onDismiss = { creditOpen = false },
            onSubmit = vm::addCredit,
        )
    }
    if (deleteYearOpen) {
        ConfirmDialog(
            title = stringResource(R.string.taxes_delete_year_title, year.toIntOrNull() ?: 0),
            text = stringResource(R.string.taxes_delete_year_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = vm::deleteYear,
            onDismiss = { deleteYearOpen = false },
        )
    }
    deletingCredit?.let { credit ->
        ConfirmDialog(
            title = stringResource(R.string.taxes_delete_line_title),
            text = stringResource(R.string.taxes_delete_line_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = { vm.deleteCredit(credit.id) },
            onDismiss = { deletingCredit = null },
        )
    }
}

@Composable
private fun Hint(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(text, modifier, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun MovesCard(
    count: Int,
    busy: Boolean,
    onReview: () -> Unit,
    onUndo: () -> Unit,
    onDismiss: () -> Unit,
) {
    SectionCard(title = stringResource(R.string.taxes_moves_title)) {
        Text(pluralStringResource(R.plurals.taxes_moves_text, count, count), style = MaterialTheme.typography.bodyMedium)
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onReview) { Text(stringResource(R.string.taxes_moves_review)) }
            OutlinedButton(onClick = onUndo, enabled = !busy) { Text(stringResource(R.string.taxes_moves_undo)) }
            TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.taxes_moves_dismiss)) }
        }
    }
}

@Composable
private fun ReconciliationTab(
    data: TaxYearPage,
    onTag: (String) -> Unit,
    onUntag: (String) -> Unit,
    onDeleteCredit: (TaxCredit) -> Unit,
    onAddCredit: () -> Unit,
    onEditDetails: () -> Unit,
    onDeleteYear: () -> Unit,
    nav: Navigator,
) {
    val rec = data.reconciliation
    val currency = rec.year.currency
    BalanceCards(data)
    if (rec.otherCurrencyLines > 0) {
        Text(
            pluralStringResource(R.plurals.taxes_other_currency, rec.otherCurrencyLines, rec.otherCurrencyLines, currency),
            color = MaterialTheme.kept.warning,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    val differences = differenceCount(rec.counts)
    SectionCard(
        title = stringResource(R.string.taxes_reconciliation),
        subtitle = stringResource(R.string.taxes_reconciliation_hint),
        contentPadding = false,
        trailing = {
            if (rec.reconciled) {
                Pill(stringResource(R.string.taxes_all_match), color = MaterialTheme.kept.positive)
            } else if (differences > 0) {
                Pill(pluralStringResource(R.plurals.taxes_differences, differences, differences), color = MaterialTheme.colorScheme.error)
            }
        },
    ) {
        if (rec.rows.isEmpty()) {
            Column(Modifier.padding(16.dp)) {
                Text(stringResource(R.string.taxes_nothing_title), style = MaterialTheme.typography.titleSmall)
                Hint(stringResource(R.string.taxes_nothing_text))
            }
        } else {
            rec.rows.forEachIndexed { index, row ->
                if (index > 0) RowDivider()
                ReconciliationRow(
                    row,
                    currency,
                    suggestions = row.office?.let { suggestionsFor(rec, it) }.orEmpty(),
                    onTag = onTag,
                    onUntag = onUntag,
                    onDeleteCredit = onDeleteCredit,
                    nav = nav,
                )
            }
        }
    }
    SectionCard(title = stringResource(R.string.taxes_add_line), subtitle = stringResource(R.string.taxes_add_line_hint)) {
        Button(onClick = onAddCredit) { Text(stringResource(R.string.taxes_line_submit)) }
    }
    val year = rec.year
    SectionCard(title = stringResource(R.string.taxes_details), subtitle = stringResource(R.string.taxes_details_hint)) {
        KeyValueRow(stringResource(R.string.taxes_form_authority), year.authority ?: stringResource(R.string.none))
        KeyValueRow(
            stringResource(R.string.taxes_assessed_total),
            year.assessedTotal?.let { LocalFormats.current.money(it, currency) } ?: stringResource(R.string.taxes_not_entered),
        )
        year.notes?.takeIf { it.isNotBlank() }?.let { KeyValueRow(stringResource(R.string.taxes_notes), it) }
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onEditDetails) { Text(stringResource(R.string.taxes_edit_details)) }
            if (year.id != null) {
                TextButton(onClick = onDeleteYear) {
                    Text(stringResource(R.string.taxes_delete_year), color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun BalanceCards(data: TaxYearPage) {
    val rec = data.reconciliation
    val balance = rec.balance
    val currency = rec.year.currency
    val formats = LocalFormats.current
    SectionCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                Hint(stringResource(R.string.taxes_paid_by_you))
                AmountText(balance.paidByMe, currency, style = MaterialTheme.typography.titleMedium)
            }
            Column(Modifier.weight(1f)) {
                Hint(stringResource(R.string.taxes_counted_by_office))
                AmountText(balance.creditedByOffice, currency, style = MaterialTheme.typography.titleMedium)
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                Hint(stringResource(R.string.taxes_assessed_total))
                if (balance.assessedTotal == null) {
                    Text(stringResource(R.string.taxes_not_entered), color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    AmountText(balance.assessedTotal, currency, style = MaterialTheme.typography.titleMedium)
                }
            }
            Column(Modifier.weight(1f)) {
                Hint(stringResource(if (balance.outcome == "refund") R.string.taxes_refund_to_expect else R.string.taxes_still_open))
                OutcomeText(balance, currency, Modifier)
                if (balance.remainingByMe != null && balance.remainingByMe != balance.remaining) {
                    Hint(stringResource(R.string.taxes_by_your_payments, formats.money(balance.remainingByMe, currency)))
                }
            }
        }
    }
}

@Composable
private fun kindLabel(kind: String): String =
    stringResource(
        when (kind) {
            "matched" -> R.string.taxes_kind_matched
            "amount_mismatch" -> R.string.taxes_kind_amount_mismatch
            "missing_office" -> R.string.taxes_kind_missing_office
            else -> R.string.taxes_kind_missing_mine
        },
    )

@Composable
private fun ReconciliationRow(
    row: TaxRow,
    currency: String,
    suggestions: List<ch.orellbuehler.kept.model.TaxSuggestion>,
    onTag: (String) -> Unit,
    onUntag: (String) -> Unit,
    onDeleteCredit: (TaxCredit) -> Unit,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    val problem = row.kind != "matched"
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (problem) MaterialTheme.colorScheme.error.copy(alpha = 0.05f) else androidx.compose.ui.graphics.Color.Transparent,
            ).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Pill(kindLabel(row.kind), color = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.kept.positive)
            if (problem) {
                Text(
                    formats.signedMoney(row.difference, currency),
                    Modifier.weight(1f).padding(start = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        Hint(stringResource(R.string.taxes_your_payment))
        val mine = row.mine
        if (mine == null) {
            Missing()
        } else {
            PaymentBlock(mine, currency, onUntag, nav)
        }
        Hint(stringResource(R.string.taxes_tax_office))
        val office = row.office
        if (office == null) {
            Missing()
        } else {
            LineBlock(
                date = office.date,
                title = office.description,
                reference = office.reference,
                amount = office.amount,
                currency = currency,
                action = {
                    IconButton(onClick = { onDeleteCredit(office) }) {
                        Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.taxes_delete_line))
                    }
                },
            )
        }
        if (row.kind == "missing_mine") {
            suggestions.forEach { suggestion ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            stringResource(R.string.taxes_possible_payment, formats.date(suggestion.bookingDate)),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Hint(listOfNotNull(suggestion.label, formats.signedMoney(suggestion.amount, currency)).joinToString(" · "))
                    }
                    OutlinedButton(onClick = { onTag(suggestion.transactionId) }) { Text(stringResource(R.string.taxes_count_as_payment)) }
                }
            }
        }
    }
}

@Composable
private fun Missing() {
    Text(
        stringResource(R.string.taxes_missing),
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun PaymentBlock(
    payment: TaxPayment,
    currency: String,
    onUntag: (String) -> Unit,
    nav: Navigator,
) {
    LineBlock(
        date = payment.date,
        title = payment.label,
        reference = payment.reference,
        amount = payment.amount,
        currency = currency,
        origin = stringResource(if (payment.via == "bill") R.string.taxes_via_bill else R.string.taxes_via_tagged),
        onOrigin = { nav.open(Routes.account(payment.accountId)) },
        action =
            if (payment.via == "tagged") {
                {
                    IconButton(onClick = { onUntag(payment.transactionId) }) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.taxes_untag))
                    }
                }
            } else {
                null
            },
    )
}

@Composable
private fun LineBlock(
    date: String,
    title: String?,
    reference: String?,
    amount: Long,
    currency: String,
    origin: String? = null,
    onOrigin: () -> Unit = {},
    action: (@Composable () -> Unit)?,
) {
    val formats = LocalFormats.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(formats.date(date), style = MaterialTheme.typography.bodyMedium)
            if (!title.isNullOrBlank()) {
                Text(
                    title,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (!reference.isNullOrBlank()) {
                Text(
                    reference,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (origin != null) {
                TextButton(
                    onClick = onOrigin,
                    contentPadding =
                        androidx.compose.foundation.layout
                            .PaddingValues(0.dp),
                ) {
                    Text(origin, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        AmountText(amount, currency, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
        action?.invoke()
    }
}

@Composable
private fun CreditSheet(
    key: Int,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (CreditFormValues) -> Unit,
) {
    val today =
        LocalSession.current?.today?.takeIf { it.isNotBlank() } ?: java.time.LocalDate
            .now()
            .toString()
    var date by rememberSaveable(key) { mutableStateOf(today) }
    var amount by rememberSaveable(key) { mutableStateOf("") }
    var reference by rememberSaveable(key) { mutableStateOf("") }
    var description by rememberSaveable(key) { mutableStateOf("") }
    FormSheet(
        title = stringResource(R.string.taxes_add_line),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(CreditFormValues(date, amount, reference, description)) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(R.string.taxes_line_submit),
    ) {
        Hint(stringResource(R.string.taxes_add_line_hint))
        DateField(stringResource(R.string.taxes_line_date), date, { date = it }, error = errors["bookingDate"])
        AmountField(stringResource(R.string.taxes_line_amount), amount, { amount = it }, error = errors["amount"])
        FormTextField(stringResource(R.string.taxes_line_reference), reference, { reference = it.take(35) }, error = errors["reference"])
        FormTextField(
            stringResource(R.string.taxes_line_description),
            description,
            { description = it.take(500) },
            error = errors["description"],
        )
    }
}

@Composable
private fun DeductionsTab(
    data: TaxYearPage,
    vm: TaxYearViewModel,
    nav: Navigator,
) {
    val summary = data.deductions
    val formats = LocalFormats.current
    data.pillar3a?.let { p3a ->
        SectionCard(
            title = stringResource(R.string.taxes_p3a_title, summary.year),
            subtitle = stringResource(R.string.taxes_p3a_hint, summary.year),
            trailing = { OutlinedButton(onClick = { nav.open(Routes.PILLAR_3A) }) { Text(stringResource(R.string.taxes_p3a_open)) } },
        ) {
            KeyValueRow(
                stringResource(if (p3a.limitUnconfirmed) R.string.taxes_p3a_limit_estimate else R.string.taxes_p3a_limit),
                p3a.limit?.let { formats.money(it, "CHF") } ?: stringResource(R.string.taxes_p3a_na),
            )
            KeyValueRow(stringResource(R.string.taxes_p3a_ordinary), formats.money(p3a.ordinary, "CHF"))
            KeyValueRow(stringResource(R.string.taxes_p3a_buy_in), formats.money(p3a.buyIn, "CHF"))
            KeyValueRow(stringResource(R.string.taxes_p3a_deductible), formats.money(p3a.deductible, "CHF"))
            if (p3a.excluded != 0L) Hint(stringResource(R.string.taxes_p3a_excluded, formats.money(p3a.excluded, "CHF")))
        }
    }
    SectionCard(
        title = stringResource(R.string.taxes_deductions_title, summary.year),
        subtitle = stringResource(R.string.taxes_deductions_hint),
        contentPadding = false,
    ) {
        if (summary.totals.isEmpty()) {
            Column(Modifier.padding(16.dp)) {
                Text(stringResource(R.string.taxes_no_deductions_title, summary.year), style = MaterialTheme.typography.titleSmall)
                Hint(stringResource(R.string.taxes_no_deductions_text))
            }
        }
        summary.totals.forEachIndexed { index, group ->
            if (index > 0) RowDivider()
            ListRow(
                title = deductionLabel(group.type),
                subtitle = group.currency,
                trailing = { AmountText(group.total, group.currency, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium) },
            )
            group.lines.forEach { line -> DeductionLineRow(line, excluded = false, onToggle = vm::exclude) }
        }
        if (summary.excluded.isNotEmpty()) {
            RowDivider()
            Text(
                stringResource(R.string.taxes_excluded),
                Modifier.padding(start = 16.dp, top = 12.dp),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            summary.excluded.forEach { line -> DeductionLineRow(line, excluded = true, onToggle = vm::include) }
        }
    }
    MappingCard(data.deductionMappings, vm, nav)
}

@Composable
private fun DeductionLineRow(
    line: TaxDeductionLine,
    excluded: Boolean,
    onToggle: (String) -> Unit,
) {
    val formats = LocalFormats.current
    val sub =
        listOfNotNull(
            line.label,
            line.type?.let { deductionLabel(it) },
            if (line.explicitYear) stringResource(R.string.taxes_deduction_year_set) else null,
        ).joinToString(" · ")
    ListRow(
        title = formats.date(line.date),
        subtitle = sub,
        modifier = Modifier.padding(start = 16.dp),
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AmountText(line.amount, line.currency, style = MaterialTheme.typography.bodyMedium)
                val transactionId = line.transactionId
                if (transactionId != null) {
                    IconButton(onClick = { onToggle(transactionId) }) {
                        if (excluded) {
                            Icon(Icons.Outlined.Undo, contentDescription = stringResource(R.string.taxes_include))
                        } else {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.taxes_exclude))
                        }
                    }
                }
            }
        },
    )
}

@Composable
private fun MappingCard(
    mappings: List<TaxDeductionMapping>,
    vm: TaxYearViewModel,
    nav: Navigator,
) {
    SectionCard(
        title = stringResource(R.string.taxes_mapping),
        subtitle = stringResource(R.string.taxes_mapping_hint),
        contentPadding = false,
    ) {
        if (mappings.isEmpty()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.taxes_no_categories_title), style = MaterialTheme.typography.titleSmall)
                Hint(stringResource(R.string.taxes_no_categories_text))
                OutlinedButton(onClick = { nav.open(Routes.SETTINGS_CATEGORIES) }) { Text(stringResource(R.string.taxes_open_categories)) }
            }
        }
        mappings.forEachIndexed { index, mapping ->
            if (index > 0) RowDivider()
            MappingRow(mapping, onSelect = { vm.setDeduction(mapping.categoryId, it) })
        }
    }
}

@Composable
private fun MappingRow(
    mapping: TaxDeductionMapping,
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val inherited = mappingIsInherited(mapping)
    val noneLabel =
        if (inherited) {
            stringResource(R.string.taxes_inherited, deductionLabel(mapping.effective.orEmpty()))
        } else {
            stringResource(R.string.taxes_not_a_deduction)
        }
    val current = mapping.own?.let { deductionLabel(it) } ?: noneLabel
    ListRow(
        title = mapping.name,
        modifier = Modifier.padding(start = if (mapping.parentId != null) 16.dp else 0.dp),
        trailing = {
            Box {
                TextButton(onClick = { open = true }) { Text(current, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    mappingChoices().forEach { type ->
                        DropdownMenuItem(
                            text = { Text(if (type.isEmpty()) noneLabel else deductionLabel(type)) },
                            onClick = {
                                open = false
                                if (type != (mapping.own ?: "")) onSelect(type)
                            },
                        )
                    }
                }
            }
        },
    )
}
