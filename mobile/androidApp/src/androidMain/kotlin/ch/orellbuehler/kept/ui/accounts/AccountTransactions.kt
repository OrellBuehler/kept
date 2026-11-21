package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.model.AccountDetailTx
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.parseColor
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept

/** The transactions of the account: search, filters, the rows of the current page and the paging. */
@Composable
internal fun TransactionsCard(
    page: AccountDetailPage,
    vm: AccountViewModel,
    nav: Navigator,
    onDialog: (AccountDialog) -> Unit,
    onOpen: (String) -> Unit,
) {
    val query by vm.txQuery.collectAsStateWithLifecycle()
    val transactions = page.transactions
    val shownFirst = if (transactions.total == 0) 0 else (transactions.page - 1) * transactions.pageSize + 1
    val shownLast = minOf(transactions.total, transactions.page * transactions.pageSize)
    SectionCard(
        title = stringResource(R.string.accounts_transactions),
        subtitle =
            pluralStringResource(
                if (query.hasFilters) R.plurals.accounts_transactions_match else R.plurals.accounts_transactions_count,
                transactions.total,
                transactions.total,
            ),
        trailing = {
            Button(onClick = { onDialog(AccountDialog.AddTransaction) }) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.add), modifier = Modifier.padding(start = 4.dp))
            }
        },
        contentPadding = false,
    ) {
        SearchRow(query, vm, onFilters = { onDialog(AccountDialog.Filters) })
        page.filterErrors.values.flatten().forEach {
            Text(
                it,
                modifier = Modifier.padding(horizontal = 16.dp),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (transactions.total == 0) {
            EmptyTransactions(query.hasFilters, vm, nav, onAdd = { onDialog(AccountDialog.AddTransaction) })
            return@SectionCard
        }
        transactions.items.forEach { tx ->
            RowDivider()
            TransactionRow(tx, page) { onOpen(tx.id) }
        }
        RowDivider()
        Pager(transactions.page, transactions.pageCount, shownFirst, shownLast, transactions.total, vm)
    }
}

@Composable
private fun SearchRow(
    query: TxQuery,
    vm: AccountViewModel,
    onFilters: () -> Unit,
) {
    var text by remember(query.q) { mutableStateOf(query.q) }
    val others = listOf(query.from, query.to, query.min, query.max).count { it.isNotBlank() }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text(stringResource(R.string.accounts_search_placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { if (text.trim() != query.q) vm.applyFilters(query.copy(q = text)) }),
        )
        IconButton(onClick = onFilters) {
            BadgedBox(badge = { if (others > 0) Badge { Text(others.toString()) } }) {
                Icon(Icons.Outlined.FilterList, contentDescription = stringResource(R.string.accounts_filters))
            }
        }
    }
}

@Composable
private fun EmptyTransactions(
    filtered: Boolean,
    vm: AccountViewModel,
    nav: Navigator,
    onAdd: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(if (filtered) R.string.accounts_no_match_title else R.string.accounts_no_transactions_title),
            style = MaterialTheme.typography.titleSmall,
        )
        Text(
            stringResource(if (filtered) R.string.accounts_no_match_text else R.string.accounts_no_transactions_text),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (filtered) {
                OutlinedButton(onClick = { vm.applyFilters(TxQuery()) }) { Text(stringResource(R.string.accounts_clear_filters)) }
            } else {
                Button(onClick = { nav.open(Routes.IMPORT) }) { Text(stringResource(R.string.accounts_import_statement)) }
                OutlinedButton(onClick = onAdd) { Text(stringResource(R.string.accounts_add_transaction)) }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TransactionRow(
    tx: AccountDetailTx,
    page: AccountDetailPage,
    onClick: () -> Unit,
) {
    val formats = LocalFormats.current
    val shared = page.account.shareBps < FULL_SHARE_BPS
    val category = tx.categoryId?.let { id -> page.categories.firstOrNull { it.id == id } }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    transactionTitle(tx) ?: stringResource(R.string.accounts_no_description),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (!tx.note.isNullOrBlank()) {
                    Icon(
                        Icons.AutoMirrored.Outlined.StickyNote2,
                        contentDescription = stringResource(R.string.accounts_has_note),
                        modifier = Modifier.size(14.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            transactionSubtitle(tx)?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                formats.date(tx.bookingDate) + (tx.reference?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SourcePill(tx)
                tx.transfer?.let { transfer ->
                    Pill(
                        stringResource(
                            if (transfer.direction == "out") R.string.accounts_transfer_to else R.string.accounts_transfer_from,
                            transfer.peerAccountName,
                        ),
                    )
                    if (transfer.status ==
                        "needs_amount"
                    ) {
                        Pill(stringResource(R.string.accounts_needs_amount_pill), color = MaterialTheme.kept.warning)
                    }
                }
                if (tx.mirrorOf?.noBankCounterpart ==
                    true
                ) {
                    Pill(stringResource(R.string.accounts_no_counterpart), color = MaterialTheme.kept.warning)
                }
                if (category !=
                    null
                ) {
                    Pill(
                        categoryLabel(category, page.categories),
                        color = parseColor(category.color, MaterialTheme.colorScheme.primary),
                    )
                }
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            AmountText(
                tx.amount,
                page.account.currency,
                tone = AmountTone.SIGNED,
                showPlus = true,
                style = MaterialTheme.typography.bodyLarge,
            )
            if (shared) {
                AmountText(
                    shareOf(tx.amount, page.account.shareBps),
                    page.account.currency,
                    tone = AmountTone.SIGNED,
                    showPlus = true,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

/** Counterparty, else description: what a row is called. Null when there is neither. */
fun transactionTitle(tx: AccountDetailTx): String? =
    tx.counterpartyName?.takeIf { it.isNotBlank() } ?: tx.description?.takeIf { it.isNotBlank() }

/** The description under the counterparty; nothing when the description already is the title. */
fun transactionSubtitle(tx: AccountDetailTx): String? =
    if (tx.counterpartyName.isNullOrBlank()) null else tx.description?.takeIf { it.isNotBlank() }

@Composable
internal fun SourcePill(tx: AccountDetailTx) {
    Pill(
        stringResource(
            when (tx.source) {
                "manual" -> R.string.accounts_source_manual
                "mirror" -> R.string.accounts_source_mirrored
                else -> R.string.accounts_source_imported
            },
        ),
    )
}

@Composable
private fun Pager(
    page: Int,
    pageCount: Int,
    first: Int,
    last: Int,
    total: Int,
    vm: AccountViewModel,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        TextButton(onClick = { vm.goToPage(page - 1) }, enabled = page > 1) { Text(stringResource(R.string.accounts_previous)) }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.accounts_range, first, last, total), style = MaterialTheme.typography.bodySmall)
            Text(
                stringResource(R.string.accounts_page_of, page, pageCount),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = { vm.goToPage(page + 1) }, enabled = page < pageCount) { Text(stringResource(R.string.accounts_next)) }
    }
}

/** From, to and the amount range of the transaction list. */
@Composable
internal fun FiltersSheet(
    initial: TxQuery,
    errors: Map<String, List<String>>,
    onDismiss: () -> Unit,
    onApply: (TxQuery) -> Unit,
    currency: String,
) {
    var draft by remember { mutableStateOf(initial) }
    FormSheet(
        title = stringResource(R.string.accounts_filters),
        onDismiss = onDismiss,
        onSubmit = { onApply(draft) },
        busy = false,
        submitLabel = stringResource(R.string.accounts_apply),
    ) {
        DateField(
            label = stringResource(R.string.accounts_filter_from),
            value = draft.from,
            onValueChange = { draft = draft.copy(from = it) },
            error = errors["from"]?.firstOrNull(),
            optional = true,
        )
        DateField(
            label = stringResource(R.string.accounts_filter_to),
            value = draft.to,
            onValueChange = { draft = draft.copy(to = it) },
            error = errors["to"]?.firstOrNull(),
            optional = true,
        )
        AmountField(
            label = stringResource(R.string.accounts_filter_min),
            value = draft.min,
            onValueChange = { draft = draft.copy(min = it) },
            error = errors["min"]?.firstOrNull(),
            currency = currency,
        )
        AmountField(
            label = stringResource(R.string.accounts_filter_max),
            value = draft.max,
            onValueChange = { draft = draft.copy(max = it) },
            error = errors["max"]?.firstOrNull(),
            currency = currency,
        )
        TextButton(
            onClick = { draft = TxQuery(q = draft.q) },
            enabled =
                draft.from.isNotBlank() || draft.to.isNotBlank() || draft.min.isNotBlank() || draft.max.isNotBlank(),
        ) {
            Text(stringResource(R.string.accounts_clear_filters))
        }
    }
}
