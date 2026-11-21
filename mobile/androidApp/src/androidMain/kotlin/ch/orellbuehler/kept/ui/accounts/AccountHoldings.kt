package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.model.AccountDetailPosition
import ch.orellbuehler.kept.model.AccountDetailSecurity
import ch.orellbuehler.kept.model.AccountDetailTrade
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept

private val sides =
    listOf(
        "buy" to R.string.accounts_side_buy,
        "sell" to R.string.accounts_side_sell,
        "split" to R.string.accounts_side_split,
    )

private fun sideLabel(side: String): Int = sides.firstOrNull { it.first == side }?.second ?: R.string.accounts_side_buy

private fun priceSourceLabel(source: String): Int =
    when (source) {
        "provider" -> R.string.accounts_price_fetched
        "trade" -> R.string.accounts_price_last_trade
        else -> R.string.accounts_price_manual
    }

/** What an investment account holds, and the trades it was built from. */
@Composable
internal fun HoldingsCard(
    page: AccountDetailPage,
    onDialog: (AccountDialog) -> Unit,
) {
    var tab by remember { mutableIntStateOf(0) }
    val positions = page.value?.positions.orEmpty()
    SectionCard(
        title = stringResource(R.string.accounts_holdings),
        subtitle = stringResource(R.string.accounts_holdings_text),
        trailing = {
            Button(onClick = { onDialog(AccountDialog.TradeForm(null)) }) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.accounts_add_trade), modifier = Modifier.padding(start = 4.dp))
            }
        },
        contentPadding = false,
    ) {
        if (page.snapshots.isNotEmpty() && page.trades.isNotEmpty()) {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(
                    Icons.Outlined.WarningAmber,
                    contentDescription = null,
                    tint = MaterialTheme.kept.warning,
                    modifier = Modifier.size(18.dp),
                )
                Text(stringResource(R.string.accounts_holdings_snapshot_warning), style = MaterialTheme.typography.bodySmall)
            }
        }
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = tab == 0, onClick = { tab = 0 }, label = { Text(stringResource(R.string.accounts_positions)) })
            FilterChip(selected = tab == 1, onClick = { tab = 1 }, label = { Text(stringResource(R.string.accounts_trades)) })
        }
        if (tab == 0) {
            if (positions.isEmpty()) {
                EmptyHoldings(R.string.accounts_no_holdings_title, R.string.accounts_no_holdings_text)
            }
            positions.forEach { position ->
                RowDivider()
                PositionRow(position, page.account.currency)
            }
        } else {
            if (page.trades.isEmpty()) {
                EmptyHoldings(R.string.accounts_no_trades_title, R.string.accounts_no_trades_text)
            }
            page.trades.forEach { trade ->
                RowDivider()
                TradeRow(
                    trade = trade,
                    currency = page.account.currency,
                    onEdit = { onDialog(AccountDialog.TradeForm(trade)) },
                    onDelete = { onDialog(AccountDialog.DeleteTrade(trade)) },
                )
            }
        }
    }
}

@Composable
private fun EmptyHoldings(
    title: Int,
    text: Int,
) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(text), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PositionRow(
    position: AccountDetailPosition,
    currency: String,
) {
    val formats = LocalFormats.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    position.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (position.estimated) Pill(stringResource(R.string.accounts_estimated_pill), color = MaterialTheme.kept.warning)
            }
            Text(
                stringResource(
                    R.string.accounts_position_line,
                    Fixed8.format(position.quantity, formats.locale),
                    Fixed8.format(position.price, formats.locale, 2),
                    position.currency,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                stringResource(
                    R.string.accounts_position_price,
                    formats.date(position.priceDate),
                    stringResource(priceSourceLabel(position.priceSource)),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            AmountText(position.value, currency, style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    stringResource(R.string.accounts_cost),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AmountText(position.cost, currency, style = MaterialTheme.typography.bodySmall)
            }
            if (position.estimated) {
                Text("–", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                AmountText(position.gain, currency, tone = AmountTone.SIGNED, showPlus = true, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun TradeRow(
    trade: AccountDetailTrade,
    currency: String,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val formats = LocalFormats.current
    val ratio =
        Fixed8.splitTerms(trade)?.let { "${it.first} : ${it.second}" } ?: "×" + Fixed8.format(trade.quantity, formats.locale)
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Pill(stringResource(sideLabel(trade.side)))
                Text(
                    trade.securityName,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            Text(
                formats.date(trade.date) + " · " +
                    if (trade.side == "split") {
                        stringResource(R.string.accounts_split_ratio, ratio)
                    } else {
                        stringResource(
                            R.string.accounts_position_line,
                            Fixed8.format(trade.quantity, formats.locale),
                            Fixed8.format(trade.price, formats.locale, 2),
                            trade.securityCurrency,
                        )
                    },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (trade.side != "split") {
            Column(horizontalAlignment = Alignment.End) {
                AmountText(trade.amount, currency, style = MaterialTheme.typography.bodyLarge)
                if (trade.fees > 0) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            stringResource(R.string.accounts_fees_incl),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        AmountText(trade.fees, currency, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        IconButton(onClick = onEdit) { Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.accounts_edit_trade)) }
        IconButton(onClick = onDelete) { Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.accounts_delete_trade)) }
    }
}

/** The trade form: buy, sell or split of one security. The amount is offered from quantity, price and fees until typed over. */
@Composable
internal fun TradeFormSheet(
    trade: AccountDetailTrade?,
    currency: String,
    securities: List<AccountDetailSecurity>,
    busy: Boolean,
    errors: Map<String, String>,
    nav: Navigator,
    onDismiss: () -> Unit,
    onSubmit: (TradeDraft) -> Unit,
) {
    val today = serverToday(LocalSession.current?.today)
    var draft by remember { mutableStateOf(TradeDraft.from(trade, currency, securities.firstOrNull()?.id.orEmpty(), today)) }
    val security = securities.firstOrNull { it.id == draft.securityId }

    fun change(next: TradeDraft) {
        val nextSecurity = securities.firstOrNull { it.id == next.securityId }
        draft = next.withSuggestedAmount(currency, nextSecurity?.currency == currency)
    }

    if (securities.isEmpty()) {
        FormSheet(
            title = stringResource(R.string.accounts_add_trade),
            onDismiss = onDismiss,
            onSubmit = {
                onDismiss()
                nav.open(Routes.INVESTMENTS)
            },
            busy = false,
            submitLabel = stringResource(R.string.accounts_add_security),
        ) {
            Text(stringResource(R.string.accounts_no_securities), style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    FormSheet(
        title = stringResource(if (trade == null) R.string.accounts_add_trade else R.string.accounts_edit_trade),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(draft) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (trade == null) R.string.accounts_add_trade else R.string.save),
    ) {
        Text(
            stringResource(if (draft.isSplit) R.string.accounts_trade_split_text else R.string.accounts_trade_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ChoiceField(
            label = stringResource(R.string.accounts_security),
            options = securities.map { Choice(it.id, "${it.name} (${it.currency})") },
            selected = draft.securityId,
            onSelect = { change(draft.copy(securityId = it)) },
            error = errors["securityId"],
        )
        Text(
            stringResource(R.string.accounts_security_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DateField(
            label = stringResource(R.string.accounts_date),
            value = draft.date,
            onValueChange = { draft = draft.copy(date = it) },
            error = errors["date"],
        )
        ChoiceField(
            label = stringResource(R.string.accounts_side),
            options = sides.map { Choice(it.first, stringResource(it.second)) },
            selected = draft.side,
            onSelect = { change(draft.copy(side = it)) },
            error = errors["side"],
        )
        if (draft.isSplit) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FormTextField(
                    label = stringResource(R.string.accounts_split_new),
                    value = draft.splitNew,
                    onValueChange = { draft = draft.copy(splitNew = it.filter(Char::isDigit)) },
                    modifier = Modifier.weight(1f),
                    error = errors["splitNew"] ?: errors["quantity"],
                    keyboardType = KeyboardType.Number,
                )
                FormTextField(
                    label = stringResource(R.string.accounts_split_old),
                    value = draft.splitOld,
                    onValueChange = { draft = draft.copy(splitOld = it.filter(Char::isDigit)) },
                    modifier = Modifier.weight(1f),
                    error = errors["splitOld"],
                    keyboardType = KeyboardType.Number,
                )
            }
            Text(
                stringResource(R.string.accounts_split_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            FormTextField(
                label = stringResource(R.string.accounts_quantity),
                value = draft.quantity,
                onValueChange = { change(draft.copy(quantity = it)) },
                error = errors["quantity"],
                hint = stringResource(R.string.accounts_quantity_hint),
                keyboardType = KeyboardType.Decimal,
            )
            FormTextField(
                label = stringResource(R.string.accounts_price_per_unit, security?.currency.orEmpty()),
                value = draft.price,
                onValueChange = { change(draft.copy(price = it)) },
                error = errors["price"],
                hint = stringResource(R.string.accounts_price_hint),
                keyboardType = KeyboardType.Decimal,
            )
            AmountField(
                label = stringResource(R.string.accounts_fees_optional),
                value = draft.fees,
                onValueChange = { change(draft.copy(fees = it)) },
                error = errors["fees"],
                currency = currency,
            )
            AmountField(
                label = stringResource(R.string.accounts_amount),
                value = draft.amount,
                onValueChange = { draft = draft.copy(amount = it, amountTouched = true) },
                error = errors["amount"],
                hint =
                    stringResource(
                        if (security?.currency == currency) R.string.accounts_trade_amount_hint else R.string.accounts_trade_amount_hint_fx,
                    ),
                currency = currency,
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
