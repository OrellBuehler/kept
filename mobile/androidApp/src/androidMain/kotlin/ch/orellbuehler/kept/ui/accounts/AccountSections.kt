package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailFillResult
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator

/** The cards of the account page, top to bottom: each is shown only where the web shows it. */
internal fun LazyListScope.accountSections(
    page: AccountDetailPage,
    vm: AccountViewModel,
    nav: Navigator,
    onDialog: (AccountDialog) -> Unit,
    onOpenTransaction: (String) -> Unit,
) {
    val account = page.account
    item(key = "header") { AccountHeader(page) }
    val suggestion = page.transfers.fillSuggestion
    if (suggestion != null && !account.fillFromTransfers && !account.archived) {
        item(key = "fill") { FillSuggestionBanner(suggestion.count, vm) }
    }
    item(key = "fill-result") { FillResultCard(vm) }
    if (page.transfers.needsAmount.isNotEmpty()) {
        item(key = "needs-amount") { NeedsAmountCard(page.transfers.needsAmount, vm, nav) }
    }
    item(key = "transactions") { TransactionsCard(page, vm, nav, onDialog, onOpenTransaction) }
    if (page.value != null && page.hasHoldings) {
        item(key = "holdings") { HoldingsCard(page, onDialog) }
    }
    if (page.showPortfolios) {
        item(key = "portfolios") { PortfoliosCard(page, vm, onDialog) }
    }
    item(key = "snapshots") { SnapshotsCard(page, onDialog) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AccountHeader(page: AccountDetailPage) {
    val account = page.account
    val value = page.value
    val ibanMode = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    val iban = account.iban?.let { displayIban(it, ibanMode) }
    val context = LocalContext.current
    val copied = stringResource(R.string.accounts_iban_copied)
    val topUpCopied = stringResource(R.string.accounts_top_up_iban_copied)
    SectionCard {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            AccountBadges(account)
        }
        account.institution?.let {
            Text(it.name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        websiteOf(account)?.let { url ->
            TextButton(onClick = { openWebsite(context, url) }, contentPadding = PaddingValues(0.dp)) {
                Text(stringResource(R.string.accounts_website))
                Icon(
                    Icons.AutoMirrored.Outlined.OpenInNew,
                    contentDescription = null,
                    modifier = Modifier.padding(start = 4.dp).size(16.dp),
                )
            }
        }
        val rawIban = account.iban
        if (iban != null && rawIban != null) {
            IbanRow(iban, stringResource(R.string.accounts_copy_iban)) { copyToClipboard(context, formatIban(rawIban), copied) }
        }
        account.depositIban?.takeIf { account.type != "pillar_3a" }?.let { topUpIban ->
            displayIban(topUpIban, ibanMode)?.let { shown ->
                IbanRow(
                    stringResource(R.string.accounts_top_up_via, shown),
                    stringResource(R.string.accounts_copy_top_up_iban),
                ) { copyToClipboard(context, formatIban(topUpIban), topUpCopied) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(if (value != null) R.string.accounts_total_label else R.string.accounts_current_balance),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        AmountText(
            page.balance,
            account.currency,
            tone = AmountTone.NEGATIVE,
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.SemiBold,
        )
        if (value != null) {
            Breakdown(R.string.accounts_cash, value.cash, account.currency)
            if (page.hasHoldings) Breakdown(R.string.accounts_holdings, value.holdings, account.currency)
            if (page.showPortfolios) Breakdown(R.string.accounts_portfolios, value.portfolios, account.currency)
            if (page.hasHoldings && value.estimated) {
                Text(
                    stringResource(R.string.accounts_estimated),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (account.shareBps < FULL_SHARE_BPS) {
            Breakdown(R.string.accounts_my_share, shareOf(page.balance, account.shareBps), account.currency)
        }
        if (account.lastBookingDate != null) {
            Text(
                stringResource(R.string.accounts_last_booking, LocalFormats.current.date(account.lastBookingDate)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun IbanRow(
    text: String,
    copyLabel: String,
    onCopy: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f, fill = false),
        )
        IconButton(onClick = onCopy, modifier = Modifier.size(36.dp)) {
            Icon(Icons.Outlined.ContentCopy, contentDescription = copyLabel, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Breakdown(
    label: Int,
    amount: Long,
    currency: String,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        AmountText(amount, currency, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
internal fun FillResultCard(vm: AccountViewModel) {
    val result by vm.fillResult.collectAsStateWithLifecycle()
    val shown = result ?: return
    SectionCard(
        title = stringResource(R.string.accounts_filled_title),
        onClick = vm::dismissFillResult,
    ) {
        val lines = fillSummary(shown)
        if (lines.isEmpty()) {
            Text(stringResource(R.string.accounts_filled_nothing), style = MaterialTheme.typography.bodyMedium)
        } else {
            lines.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }
    }
}

/** The lines that say what filling from transfers did: linked, filled in, waiting for an amount. */
@Composable
private fun fillSummary(result: AccountDetailFillResult): List<String> =
    buildList {
        if (result.paired > 0) add(pluralStringResource(R.plurals.accounts_filled_linked, result.paired, result.paired))
        if (result.mirrored > 0) {
            add(pluralStringResource(R.plurals.accounts_filled_mirrored, result.mirrored, result.mirrored))
        }
        if (result.needsAmount > 0) {
            add(pluralStringResource(R.plurals.accounts_filled_needs_amount, result.needsAmount, result.needsAmount))
        }
    }
