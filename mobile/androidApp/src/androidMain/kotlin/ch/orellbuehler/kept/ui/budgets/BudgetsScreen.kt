package ch.orellbuehler.kept.ui.budgets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Savings
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.BudgetCategory
import ch.orellbuehler.kept.model.BudgetCurrencyReport
import ch.orellbuehler.kept.model.BudgetRow
import ch.orellbuehler.kept.model.BudgetsPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ProgressBar
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.parseColor
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow

private const val PATH = "budgets"

class BudgetsViewModel(
    sdk: KeptSdk,
    private val month: MutableStateFlow<String?> = MutableStateFlow(null),
    private val basis: MutableStateFlow<String?> = MutableStateFlow(null),
) : PageViewModel<BudgetsPage>(sdk, { it.load(PATH, budgetsQuery(month.value, basis.value)) }) {
    fun goTo(value: String) {
        if (value.isBlank() || month.value == value) return
        month.value = value
        refresh()
    }

    fun setBasis(value: String) {
        if (basis.value == value) return
        basis.value = value
        refresh()
    }

    fun save(
        id: String?,
        categoryId: String,
        currency: String,
        amount: String,
    ) = submit(PATH, if (id == null) "createBudget" else "updateBudget", budgetFields(id, categoryId, currency, amount).toFormBody())

    fun delete(id: String) = submit(PATH, "deleteBudget", FormBody().set("id", id), showRefusal = true)
}

private sealed interface BudgetSheet {
    data object Closed : BudgetSheet

    data class Editing(
        val row: BudgetRow?,
        val currency: String,
    ) : BudgetSheet
}

/** Monthly budgets per category: spent against the limit, by currency. */
@Composable
fun BudgetsScreen(nav: Navigator) {
    val vm = keptViewModel { BudgetsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf<BudgetSheet>(BudgetSheet.Closed) }
    var deleting by remember { mutableStateOf<BudgetRow?>(null) }
    val canAdd = (state as? Load.Ready)?.value?.let { expenseCategories(it.categories).isNotEmpty() } == true

    fun openForm(
        row: BudgetRow?,
        currency: String,
    ) {
        vm.clearFormErrors()
        sheet = BudgetSheet.Editing(row, currency)
    }

    PageScaffold(
        title = stringResource(R.string.nav_budgets),
        state = state,
        onRefresh = vm::refresh,
        events = vm.events,
        onEvent = {
            when (it) {
                UiEvent.Saved -> sheet = BudgetSheet.Closed
                is UiEvent.Navigate -> nav.openWebPath(it.webPath, replace = true)
                is UiEvent.Message -> Unit
            }
        },
        floatingActionButton = {
            if (canAdd) {
                FloatingActionButton(onClick = { openForm(null, "") }) {
                    Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.budgets_add))
                }
            }
        },
    ) { page, padding ->
        val expense = expenseCategories(page.categories)
        ScrollColumn(padding) {
            MonthBar(page, vm::goTo)
            if (page.hasShared) BasisBar(page.basis, vm::setBasis)
            when {
                expense.isEmpty() ->
                    MessagePane(
                        icon = Icons.Outlined.Savings,
                        title = stringResource(R.string.budgets_no_categories_title),
                        text = stringResource(R.string.budgets_no_categories_text),
                        action = stringResource(R.string.budgets_manage_categories),
                        onAction = { nav.open(Routes.SETTINGS_CATEGORIES) },
                    )
                page.report.currencies.isEmpty() ->
                    MessagePane(
                        icon = Icons.Outlined.Savings,
                        title = stringResource(R.string.budgets_empty_title, LocalFormats.current.month(page.month)),
                        text = stringResource(R.string.budgets_empty_text),
                        action = stringResource(R.string.budgets_add),
                        onAction = { openForm(null, "") },
                    )
                else ->
                    page.report.currencies.forEach { report ->
                        CurrencyCard(report, onEdit = { openForm(it, report.currency) }, onDelete = { deleting = it })
                    }
            }
        }
        (sheet as? BudgetSheet.Editing)?.let { editing ->
            BudgetFormSheet(
                editing = editing,
                categories = expense,
                currencies = page.currencies,
                busy = busy,
                errors = errors,
                onDismiss = { sheet = BudgetSheet.Closed },
                onSubmit = { categoryId, currency, amount -> vm.save(editing.row?.budgetId, categoryId, currency, amount) },
            )
        }
    }

    deleting?.let { row ->
        ConfirmDialog(
            title = stringResource(R.string.budgets_delete_title, row.categoryName),
            text = stringResource(R.string.budgets_delete_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = { vm.delete(row.budgetId) },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun MonthBar(
    page: BudgetsPage,
    onMonth: (String) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { onMonth(page.previousMonth) }) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = stringResource(R.string.budgets_previous_month))
        }
        Text(
            LocalFormats.current.month(page.month),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.Center,
        )
        IconButton(onClick = { onMonth(page.nextMonth) }) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.budgets_next_month))
        }
        if (page.month != page.currentMonth) {
            TextButton(onClick = { onMonth(page.currentMonth) }) { Text(stringResource(R.string.budgets_this_month), maxLines = 1) }
        }
    }
}

@Composable
private fun BasisBar(
    basis: String,
    onBasis: (String) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        FilterChip(
            selected = basis == "share",
            onClick = { onBasis("share") },
            label = { Text(stringResource(R.string.budgets_basis_share)) },
        )
        FilterChip(
            selected = basis == "total",
            onClick = { onBasis("total") },
            label = { Text(stringResource(R.string.budgets_basis_total)) },
        )
    }
    Text(
        stringResource(if (basis == "share") R.string.budgets_basis_share_text else R.string.budgets_basis_total_text),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun CurrencyCard(
    report: BudgetCurrencyReport,
    onEdit: (BudgetRow) -> Unit,
    onDelete: (BudgetRow) -> Unit,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = report.currency,
        subtitle =
            if (report.rows.isEmpty()) {
                stringResource(R.string.budgets_no_budgets)
            } else {
                stringResource(
                    R.string.budgets_of,
                    formats.money(report.totalSpent, report.currency),
                    formats.money(report.totalBudget, report.currency),
                )
            },
        contentPadding = false,
    ) {
        report.rows.forEachIndexed { index, row ->
            if (index > 0) RowDivider()
            BudgetRowItem(row, report.currency, onEdit, onDelete)
        }
        if (report.unbudgeted.isNotEmpty()) {
            if (report.rows.isNotEmpty()) RowDivider()
            Text(
                stringResource(R.string.budgets_unbudgeted),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
            )
            report.unbudgeted.forEach { row ->
                ListRow(
                    title = row.parentName?.let { "$it / ${row.categoryName}" } ?: row.categoryName,
                    leading = { ColorDot(row.color) },
                ) { AmountText(row.spent, report.currency) }
            }
        }
    }
}

@Composable
private fun ColorDot(color: String?) {
    Box(Modifier.size(10.dp).clip(CircleShape).background(parseColor(color, MaterialTheme.colorScheme.outline)))
}

@Composable
private fun BudgetRowItem(
    row: BudgetRow,
    currency: String,
    onEdit: (BudgetRow) -> Unit,
    onDelete: (BudgetRow) -> Unit,
) {
    val formats = LocalFormats.current
    var menu by remember { mutableStateOf(false) }
    val tone = if (row.over) MaterialTheme.kept.negative else MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(top = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ColorDot(row.color)
                Text(
                    row.parentName?.let { "$it / ${row.categoryName}" } ?: row.categoryName,
                    modifier = Modifier.weight(1f).padding(start = 8.dp),
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                stringResource(R.string.budgets_of, formats.money(row.spent, currency), formats.money(row.budget, currency)),
                style = MaterialTheme.typography.bodyMedium,
                color = if (row.over) MaterialTheme.kept.negative else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(top = 4.dp),
            )
            ProgressBar(budgetPercent(row.spent, row.budget) / 100f, Modifier.padding(top = 6.dp), color = tone)
            Text(
                if (row.over) {
                    stringResource(R.string.budgets_over_by, formats.money(-row.remaining, currency))
                } else {
                    stringResource(R.string.budgets_left, formats.money(row.remaining, currency))
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (row.over) MaterialTheme.kept.negative else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
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
                        onEdit(row)
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menu = false
                        onDelete(row)
                    },
                )
            }
        }
    }
}

@Composable
private fun BudgetFormSheet(
    editing: BudgetSheet.Editing,
    categories: List<BudgetCategory>,
    currencies: List<String>,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (categoryId: String, currency: String, amount: String) -> Unit,
) {
    val row = editing.row
    var categoryId by rememberSaveable { mutableStateOf(row?.categoryId ?: categories.firstOrNull()?.id.orEmpty()) }
    var currency by rememberSaveable { mutableStateOf(editing.currency.ifBlank { currencies.firstOrNull().orEmpty() }) }
    var amount by rememberSaveable { mutableStateOf(row?.let { Amounts.toInput(it.budget, editing.currency) }.orEmpty()) }
    FormSheet(
        title = stringResource(if (row == null) R.string.budgets_add else R.string.budgets_edit_title),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(categoryId, currency, amount) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (row == null) R.string.budgets_add else R.string.save),
    ) {
        Text(
            stringResource(R.string.budgets_form_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ChoiceField(
            label = stringResource(R.string.budgets_category),
            options = categories.map { Choice(it.id, budgetCategoryLabel(it, categories)) },
            selected = categoryId,
            onSelect = { categoryId = it },
            error = errors["categoryId"],
        )
        FormTextField(
            label = stringResource(R.string.budgets_currency),
            value = currency,
            onValueChange = { currency = it.uppercase().take(3) },
            error = errors["currency"],
            hint = currencies.takeIf { it.isNotEmpty() }?.joinToString(", "),
        )
        AmountField(
            label = stringResource(R.string.budgets_amount),
            value = amount,
            onValueChange = { amount = it },
            error = errors["amount"],
            currency = currency.ifBlank { null },
        )
    }
}
