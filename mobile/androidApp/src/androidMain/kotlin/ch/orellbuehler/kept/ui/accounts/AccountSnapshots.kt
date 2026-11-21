package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard

/** Balances recorded by hand (or by an import) on given days. */
@Composable
internal fun SnapshotsCard(
    page: AccountDetailPage,
    onDialog: (AccountDialog) -> Unit,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = stringResource(R.string.accounts_snapshots),
        subtitle =
            stringResource(
                when {
                    page.showPortfolios -> R.string.accounts_snapshots_portfolios
                    page.hasHoldings -> R.string.accounts_snapshots_holdings
                    else -> R.string.accounts_snapshots_text
                },
            ),
        trailing = {
            Button(onClick = { onDialog(AccountDialog.AddSnapshot) }) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.add), modifier = Modifier.padding(start = 4.dp))
            }
        },
        contentPadding = false,
    ) {
        if (page.snapshots.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.accounts_snapshots_empty_title), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.accounts_snapshots_empty_text),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        page.snapshots.forEachIndexed { index, snapshot ->
            if (index > 0) RowDivider()
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(formats.date(snapshot.date), style = MaterialTheme.typography.bodyLarge)
                    if (!snapshot.note.isNullOrBlank()) {
                        Text(
                            snapshot.note,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                        )
                    }
                }
                Pill(
                    stringResource(
                        if (snapshot.source ==
                            "manual"
                        ) {
                            R.string.accounts_source_manual
                        } else {
                            R.string.accounts_source_imported
                        },
                    ),
                )
                AmountText(snapshot.amount, page.account.currency, style = MaterialTheme.typography.bodyLarge)
                if (snapshot.source == "manual") {
                    IconButton(onClick = { onDialog(AccountDialog.DeleteSnapshot(snapshot)) }) {
                        Icon(
                            Icons.Outlined.Delete,
                            contentDescription = stringResource(R.string.accounts_delete_snapshot, formats.date(snapshot.date)),
                        )
                    }
                } else {
                    Column(Modifier.size(48.dp)) {}
                }
            }
        }
    }
}

@Composable
internal fun SnapshotFormSheet(
    currency: String,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (SnapshotDraft) -> Unit,
) {
    val today = serverToday(LocalSession.current?.today)
    var draft by remember { mutableStateOf(SnapshotDraft(date = today)) }
    FormSheet(
        title = stringResource(R.string.accounts_add_snapshot),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(draft) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(R.string.accounts_add_snapshot),
        submitEnabled = draft.amount.isNotBlank(),
    ) {
        Text(
            stringResource(R.string.accounts_snapshot_text),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DateField(
            label = stringResource(R.string.accounts_date),
            value = draft.date,
            onValueChange = { draft = draft.copy(date = it) },
            error = errors["date"],
        )
        AmountField(
            label = stringResource(R.string.accounts_balance),
            value = draft.amount,
            onValueChange = { draft = draft.copy(amount = it) },
            error = errors["amount"],
            hint = stringResource(R.string.accounts_snapshot_amount_hint),
            currency = currency,
        )
        FormTextField(
            label = stringResource(R.string.accounts_note_optional),
            value = draft.note,
            onValueChange = { draft = draft.copy(note = it) },
            error = errors["note"],
            capitalization = KeyboardCapitalization.Sentences,
        )
    }
}
