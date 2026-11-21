package ch.orellbuehler.kept.ui.bills

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.BillSuggestion
import ch.orellbuehler.kept.model.BillTransaction
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.theme.kept

fun statusLabel(status: String): Int =
    when (status) {
        "partially_paid" -> R.string.bills_status_partially_paid
        "paid" -> R.string.bills_status_paid
        "overpaid" -> R.string.bills_status_overpaid
        "credit_due" -> R.string.bills_status_credit_due
        "cancelled" -> R.string.bills_status_cancelled
        else -> R.string.bills_status_open
    }

@Composable
fun StatusPill(
    status: String,
    modifier: Modifier = Modifier,
) {
    val color =
        when (status) {
            "paid" -> MaterialTheme.kept.positive
            "partially_paid" -> MaterialTheme.kept.warning
            "overpaid", "credit_due" -> MaterialTheme.colorScheme.tertiary
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        }
    Pill(stringResource(statusLabel(status)), modifier, color)
}

@Composable
fun dueHintText(hint: DueHint): String =
    when (hint) {
        is DueHint.Overdue -> pluralStringResource(R.plurals.bills_days_overdue, hint.days, hint.days)
        DueHint.Today -> stringResource(R.string.bills_due_today)
        DueHint.Tomorrow -> stringResource(R.string.bills_due_tomorrow)
        is DueHint.InDays -> pluralStringResource(R.plurals.bills_due_in_days, hint.days, hint.days)
    }

@Composable
fun HintText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(text, modifier = modifier, style = MaterialTheme.typography.bodySmall, color = color)
}

@Composable
fun transactionTitle(tx: BillTransaction): String = tx.counterpartyName ?: tx.description ?: stringResource(R.string.bills_transaction)

/** One proposed payment: what matched, the bill (optionally), the transaction, and confirm / dismiss. */
@Composable
fun SuggestionBlock(
    suggestion: BillSuggestion,
    showBill: Boolean,
    busy: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val formats = LocalFormats.current
    val tx = suggestion.transaction
    val bill = suggestion.bill
    val refund = suggestion.amount < 0
    Column(modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Pill(stringResource(if (suggestion.rule == "reference") R.string.bills_rule_reference else R.string.bills_rule_iban_amount))
            if (suggestion.ambiguous) Pill(stringResource(R.string.bills_several_matches), color = MaterialTheme.kept.warning)
            if (refund) Pill(stringResource(R.string.bills_refund), color = MaterialTheme.colorScheme.tertiary)
        }
        if (showBill) {
            Column {
                Text(
                    bill.creditorName ?: stringResource(R.string.bills_unnamed_creditor),
                    style = MaterialTheme.typography.bodyLarge,
                )
                val parts =
                    buildList {
                        bill.invoiceNumber?.let { add(stringResource(R.string.bills_number, it)) }
                        bill.dueDate?.let { add(stringResource(R.string.bills_due, formats.date(it))) }
                    }
                if (parts.isNotEmpty()) HintText(parts.joinToString(" · "))
                if (bill.amount != null) AmountText(bill.amount, bill.currency, style = MaterialTheme.typography.bodySmall)
            }
        }
        Column {
            Text(transactionTitle(tx), style = MaterialTheme.typography.bodyLarge)
            HintText("${tx.accountName} · ${formats.date(tx.bookingDate)}")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AmountText(tx.amount, tx.currency, tone = AmountTone.SIGNED, style = MaterialTheme.typography.bodyMedium)
                if (suggestion.amount != Math.abs(tx.amount) || refund) {
                    HintText(stringResource(R.string.bills_applies, formats.money(suggestion.amount, bill.currency)))
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onConfirm, enabled = !busy) {
                Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_confirm), modifier = Modifier.padding(start = 6.dp))
            }
            OutlinedButton(onClick = onDismiss, enabled = !busy) {
                Icon(Icons.Outlined.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_dismiss), modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}
