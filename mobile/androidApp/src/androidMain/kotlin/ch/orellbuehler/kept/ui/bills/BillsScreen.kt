package ch.orellbuehler.kept.ui.bills

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.BillItem
import ch.orellbuehler.kept.model.BillMatchResult
import ch.orellbuehler.kept.model.BillSuggestion
import ch.orellbuehler.kept.model.BillsPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.IconBadge
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

data class BillsFilter(
    val q: String = "",
    val status: String = "all",
    val page: Int = 1,
)

class BillsViewModel(
    sdk: KeptSdk,
    private val filter: MutableStateFlow<BillsFilter> = MutableStateFlow(BillsFilter()),
) : PageViewModel<BillsPage>(sdk, { it.load("bills", billListQuery(filter.value.q, filter.value.status, filter.value.page)) }) {
    fun search(
        q: String,
        status: String,
    ) {
        filter.value = BillsFilter(q.trim(), status, 1)
        refresh()
    }

    fun goTo(page: Int) {
        filter.update { it.copy(page = page) }
        refresh()
    }

    fun matchNow(matchedMessage: (Int) -> String) {
        submit("bills", "matchNow", showRefusal = true) { result ->
            val matched = runCatching { ApiJson.decodeFromString<BillMatchResult>(result.json).matched }.getOrDefault(0)
            message(matchedMessage(matched))
        }
    }

    fun confirm(suggestion: BillSuggestion) {
        submit(
            "bills",
            "confirmSuggestion",
            FormBody()
                .set("billId", suggestion.billId)
                .set("transactionId", suggestion.transactionId)
                .set(
                    "amount",
                    ch.orellbuehler.kept.Amounts
                        .toInput(suggestion.amount, suggestion.bill.currency),
                ),
            showRefusal = true,
        )
    }

    fun dismiss(suggestion: BillSuggestion) {
        submit(
            "bills",
            "dismissSuggestion",
            FormBody().set("billId", suggestion.billId).set("transactionId", suggestion.transactionId),
            showRefusal = true,
        )
    }
}

/** The bills overview: what is overdue or due soon, suggested payments to confirm, and every bill with search and filter. */
@Composable
fun BillsScreen(nav: Navigator) {
    val vm = keptViewModel { BillsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    PageScaffold(
        title = stringResource(R.string.nav_bills),
        state = state,
        onRefresh = vm::refresh,
        events = vm.events,
        onEvent = { if (it is UiEvent.Navigate) nav.openWebPath(it.webPath) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { nav.open(Routes.BILL_NEW) },
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text(stringResource(R.string.bills_add)) },
            )
        },
    ) { page, padding ->
        ScrollColumn(padding) {
            BillsContent(page, busy, vm, nav)
        }
    }
}

@Composable
private fun BillsContent(
    page: BillsPage,
    busy: Boolean,
    vm: BillsViewModel,
    nav: Navigator,
) {
    val filtered = page.query.q.isNotEmpty() || page.query.status != "all"
    if (page.autoMatchPending > 0) {
        val resources = LocalContext.current.resources
        SectionCard {
            Text(pluralStringResource(R.plurals.bills_auto_match, page.autoMatchPending, page.autoMatchPending))
            Button(
                onClick = { vm.matchNow { n -> resources.getQuantityString(R.plurals.bills_matched, n, n) } },
                enabled = !busy,
                modifier = Modifier.padding(top = 8.dp),
            ) { Text(stringResource(R.string.bills_match_now)) }
        }
    }
    if (page.matchingFailed) {
        Notice(stringResource(R.string.bills_matching_failed), MaterialTheme.colorScheme.error)
    } else if (page.suggestionsTruncated) {
        Notice(stringResource(R.string.bills_matching_truncated), MaterialTheme.kept.warning)
    }
    if (page.suggestions.isNotEmpty()) {
        SectionCard(
            title = stringResource(R.string.bills_suggestions),
            subtitle = page.suggestions.size.toString(),
            contentPadding = false,
        ) {
            page.suggestions.forEachIndexed { index, suggestion ->
                if (index > 0) RowDivider()
                SuggestionBlock(
                    suggestion = suggestion,
                    showBill = true,
                    busy = busy,
                    onConfirm = { vm.confirm(suggestion) },
                    onDismiss = { vm.dismiss(suggestion) },
                )
            }
        }
    }
    if (page.counts.total == 0) {
        MessagePane(
            icon = Icons.AutoMirrored.Outlined.ReceiptLong,
            title = stringResource(R.string.bills_empty_title),
            text = stringResource(R.string.bills_empty_text),
            modifier = Modifier.padding(top = 24.dp),
            action = stringResource(R.string.bills_add),
            onAction = { nav.open(Routes.BILL_NEW) },
        )
        return
    }
    if (!filtered && page.list.page == 1) {
        BillGroup(stringResource(R.string.bills_group_overdue), page.groups.overdue, nav, alarming = true)
        BillGroup(stringResource(R.string.bills_group_due_soon), page.groups.dueSoon, nav)
        BillGroup(stringResource(R.string.bills_group_refund), page.groups.awaitingRefund, nav)
    }
    SearchBar(page, vm)
    if (page.list.total == 0) {
        MessagePane(
            icon = Icons.Outlined.Search,
            title = stringResource(R.string.bills_no_match_title),
            text = stringResource(R.string.bills_no_match_text),
            modifier = Modifier.padding(top = 16.dp),
            action = if (filtered) stringResource(R.string.bills_clear_filter) else null,
            onAction = { vm.search("", "all") },
        )
        return
    }
    SectionCard(contentPadding = false) {
        page.list.items.forEachIndexed { index, bill ->
            if (index > 0) RowDivider()
            BillRow(bill, nav)
        }
    }
    if (page.list.pageCount > 1) Pager(page, vm)
}

@Composable
private fun Notice(
    text: String,
    color: androidx.compose.ui.graphics.Color,
) {
    SectionCard { Text(text, style = MaterialTheme.typography.bodyMedium, color = color) }
}

@Composable
private fun BillGroup(
    title: String,
    bills: List<BillItem>,
    nav: Navigator,
    alarming: Boolean = false,
) {
    if (bills.isEmpty()) return
    SectionCard(
        title = title,
        subtitle = bills.size.toString(),
        contentPadding = false,
    ) {
        bills.forEachIndexed { index, bill ->
            RowDivider()
            BillRow(bill, nav, alarming)
        }
    }
}

@Composable
private fun SearchBar(
    page: BillsPage,
    vm: BillsViewModel,
) {
    var text by rememberSaveable { mutableStateOf(page.query.q) }
    val status = page.query.status
    val apply = { vm.search(text, status) }
    SectionCard(title = stringResource(R.string.bills_all), subtitle = page.list.total.toString()) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(stringResource(R.string.bills_search_placeholder)) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = {
                if (text.isNotEmpty()) {
                    IconButton(onClick = {
                        text = ""
                        vm.search("", status)
                    }) { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.clear)) }
                }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { apply() }),
        )
        Row(
            Modifier.padding(top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ChoiceField(
                label = stringResource(R.string.bills_filter_status),
                options = billStatusFilters.map { Choice(it, stringResource(filterLabel(it))) },
                selected = status,
                onSelect = { vm.search(text, it) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

private fun filterLabel(status: String): Int =
    when (status) {
        "open" -> R.string.bills_filter_open
        "overdue" -> R.string.bills_filter_overdue
        "paid" -> R.string.bills_filter_paid
        "refund" -> R.string.bills_filter_refund
        "cancelled" -> R.string.bills_filter_cancelled
        else -> R.string.bills_filter_all
    }

@Composable
private fun Pager(
    page: BillsPage,
    vm: BillsViewModel,
) {
    val (first, last) = pageRange(page.list.page, page.list.pageSize, page.list.total)
    SectionCard {
        Text(
            stringResource(R.string.bills_page_range, first, last, page.list.total),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = { vm.goTo(page.list.page - 1) }, enabled = page.list.page > 1) {
                Text(stringResource(R.string.bills_previous))
            }
            Text(
                stringResource(R.string.bills_page_of, page.list.page, page.list.pageCount),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedButton(onClick = { vm.goTo(page.list.page + 1) }, enabled = page.list.page < page.list.pageCount) {
                Text(stringResource(R.string.bills_next))
            }
        }
    }
}

/** A bill in a list: who, what, when, how much, and its status. */
@Composable
fun BillRow(
    bill: BillItem,
    nav: Navigator,
    alarming: Boolean = false,
) {
    val formats = LocalFormats.current
    val hint = dueHint(bill)
    val parts =
        buildList {
            if (bill.isCreditNote) add(stringResource(R.string.bills_kind_credit_note))
            bill.invoiceNumber?.let { add(stringResource(R.string.bills_number, it)) }
            add(bill.dueDate?.let { stringResource(R.string.bills_due, formats.date(it)) } ?: stringResource(R.string.bills_no_due_date))
            hint?.let { add(dueHintText(it)) }
        }
    ListRow(
        title = bill.creditorName ?: stringResource(R.string.bills_unnamed_creditor),
        subtitle = parts.joinToString(" · "),
        leading = {
            IconBadge(
                Icons.AutoMirrored.Outlined.ReceiptLong,
                tint = if (bill.overdue || alarming) MaterialTheme.kept.negative else MaterialTheme.colorScheme.primary,
            )
        },
        onClick = { nav.open(Routes.bill(bill.id)) },
    ) {
        if (bill.amount != null) {
            AmountText(bill.amount, bill.currency, style = MaterialTheme.typography.bodyLarge)
        } else {
            Text(stringResource(R.string.bills_open_amount), style = MaterialTheme.typography.bodySmall)
        }
        if (showsRemaining(bill) && bill.remaining != null) {
            Text(
                stringResource(R.string.bills_remaining, formats.money(bill.remaining, bill.currency)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (isRefundDue(bill) && bill.remaining != null) {
            Text(
                stringResource(R.string.bills_refund_expected),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StatusPill(bill.status, Modifier.padding(top = 4.dp))
    }
}
