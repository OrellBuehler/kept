package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailNeedsAmount
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import kotlin.math.abs

/** Offers to create the counter-transactions of transfers other accounts show to this account's IBAN. */
@Composable
internal fun FillSuggestionBanner(
    count: Int,
    vm: AccountViewModel,
) {
    val busy by vm.busy.collectAsStateWithLifecycle()
    SectionCard(title = stringResource(R.string.accounts_fill_title)) {
        Text(pluralStringResource(R.plurals.accounts_fill_text, count, count), style = MaterialTheme.typography.bodyMedium)
        Button(onClick = vm::enableFillFromTransfers, enabled = !busy, modifier = Modifier.padding(top = 12.dp)) {
            Text(stringResource(R.string.accounts_fill_action))
        }
    }
}

/** Transfers in another currency: enter the amount this account booked, or link a booked row instead. */
@Composable
internal fun NeedsAmountCard(
    items: List<AccountDetailNeedsAmount>,
    vm: AccountViewModel,
    nav: Navigator,
) {
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var submitted by remember { mutableStateOf<String?>(null) }
    SectionCard(
        title = stringResource(R.string.accounts_needs_title),
        subtitle = pluralStringResource(R.plurals.accounts_needs_text, items.size, items.size),
        contentPadding = false,
    ) {
        items.forEachIndexed { index, item ->
            if (index > 0) RowDivider()
            NeedsAmountRow(
                item = item,
                busy = busy,
                errors = if (submitted == item.transferId) errors else emptyMap(),
                onOpenSource = { nav.open(Routes.account(item.sourceAccountId)) },
                onSave = { amount ->
                    submitted = item.transferId
                    vm.resolveNeedsAmount(item.transferId, amount)
                },
                onLink = { peerId ->
                    submitted = item.transferId
                    vm.linkNeedsAmount(item.transferId, peerId)
                },
            )
        }
    }
}

@Composable
private fun NeedsAmountRow(
    item: AccountDetailNeedsAmount,
    busy: Boolean,
    errors: Map<String, String>,
    onOpenSource: () -> Unit,
    onSave: (String) -> Unit,
    onLink: (String) -> Unit,
) {
    val formats = LocalFormats.current
    val incoming = item.direction == "in"
    var amount by remember(item.transferId) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(
                if (incoming) R.string.accounts_needs_from else R.string.accounts_needs_to,
                item.sourceAccountName,
                formats.date(item.bookingDate),
            ),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.clickable(onClick = onOpenSource),
        )
        if (!item.description.isNullOrBlank()) {
            Text(item.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                stringResource(if (incoming) R.string.accounts_needs_paid else R.string.accounts_needs_received),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            AmountText(abs(item.amount), item.currency, style = MaterialTheme.typography.bodySmall)
        }
        item.linkCandidate?.let { candidate ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    stringResource(R.string.accounts_needs_link_text, formats.date(candidate.bookingDate)),
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AmountText(
                        candidate.amount,
                        candidate.currency,
                        tone = AmountTone.SIGNED,
                        showPlus = true,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (!candidate.description.isNullOrBlank()) {
                        Text(
                            candidate.description,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                }
                OutlinedButton(onClick = { onLink(candidate.id) }, enabled = !busy) { Text(stringResource(R.string.accounts_needs_link)) }
            }
        }
        AmountField(
            label = stringResource(if (incoming) R.string.accounts_needs_amount_received else R.string.accounts_needs_amount_paid),
            value = amount,
            onValueChange = { amount = it },
            error = errors["amount"],
            currency = item.targetCurrency,
        )
        errors["form"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { onSave(amount) }, enabled = !busy && amount.isNotBlank()) { Text(stringResource(R.string.save)) }
        }
    }
}
