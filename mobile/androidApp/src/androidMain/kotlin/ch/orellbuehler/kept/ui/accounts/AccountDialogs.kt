package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.nav.Navigator

/** Shows the dialog or sheet [dialog] names, wired to the view model; [onClose] closes it. */
@Composable
internal fun AccountDialogs(
    page: AccountDetailPage,
    dialog: AccountDialog?,
    vm: AccountViewModel,
    busy: Boolean,
    errors: Map<String, String>,
    nav: Navigator,
    onClose: () -> Unit,
    onOpen: (AccountDialog) -> Unit,
    onTransactionGone: () -> Unit,
) {
    val account = page.account
    val formats = LocalFormats.current
    val query by vm.txQuery.collectAsStateWithLifecycle()
    when (dialog) {
        null -> Unit
        AccountDialog.EditAccount ->
            AccountFormSheet(
                account = account,
                institutions = page.institutions.map { it.id to it.name },
                defaultInstitutionId = "",
                busy = busy,
                errors = errors,
                onDismiss = onClose,
                onSubmit = vm::updateAccount,
                currencyLocked = isCurrencyLocked(page),
                mirrorCount = page.transfers.mirrorCount,
                hasPortfolios = page.portfolios.isNotEmpty(),
                hasTrades = page.trades.isNotEmpty(),
            )
        AccountDialog.DeleteAccount ->
            TypedConfirmDialog(
                title = stringResource(R.string.accounts_delete_account, account.name),
                text = stringResource(R.string.accounts_delete_account_text),
                confirmText = account.name,
                confirmLabel = stringResource(R.string.accounts_delete_account_action),
                onConfirm = vm::deleteAccount,
                onDismiss = onClose,
            )
        AccountDialog.AddTransaction ->
            TransactionFormSheet(null, account.currency, busy, errors, onClose) { vm.addTransaction(it) }
        is AccountDialog.EditTransaction ->
            TransactionFormSheet(dialog.tx, account.currency, busy, errors, onClose) { vm.updateTransaction(dialog.tx, it) }
        is AccountDialog.DeleteTransaction -> {
            val mirror = dialog.tx.source == "mirror"
            ConfirmDialog(
                title = stringResource(if (mirror) R.string.accounts_remove_mirror_title else R.string.accounts_delete_transaction_title),
                text = stringResource(if (mirror) R.string.accounts_remove_mirror_text else R.string.accounts_delete_transaction_text),
                confirmLabel = stringResource(if (mirror) R.string.accounts_remove_mirror else R.string.delete),
                onConfirm = {
                    onTransactionGone()
                    vm.deleteTransaction(dialog.tx.id)
                },
                onDismiss = onClose,
            )
        }
        AccountDialog.Filters ->
            FiltersSheet(
                initial = query,
                errors = page.filterErrors,
                onDismiss = onClose,
                onApply = {
                    vm.applyFilters(it)
                    onClose()
                },
                currency = account.currency,
            )
        AccountDialog.AddSnapshot -> SnapshotFormSheet(account.currency, busy, errors, onClose) { vm.addSnapshot(it) }
        is AccountDialog.DeleteSnapshot ->
            ConfirmDialog(
                title = stringResource(R.string.accounts_delete_snapshot_title),
                text = stringResource(R.string.accounts_delete_snapshot_text, formats.date(dialog.snapshot.date)),
                confirmLabel = stringResource(R.string.delete),
                onConfirm = { vm.deleteSnapshot(dialog.snapshot.id) },
                onDismiss = onClose,
            )
        is AccountDialog.TradeForm ->
            TradeFormSheet(
                dialog.trade,
                account.currency,
                page.securities,
                busy,
                errors,
                nav,
                onClose,
            ) { vm.saveTrade(dialog.trade?.id, it) }
        is AccountDialog.DeleteTrade ->
            ConfirmDialog(
                title = stringResource(R.string.accounts_delete_trade_title),
                text = stringResource(R.string.accounts_delete_trade_text, dialog.trade.securityName, formats.date(dialog.trade.date)),
                confirmLabel = stringResource(R.string.delete),
                onConfirm = { vm.deleteTrade(dialog.trade.id) },
                onDismiss = onClose,
            )
        is AccountDialog.PortfolioForm ->
            PortfolioFormSheet(
                portfolio = dialog.portfolio,
                qrIban = account.depositIban?.let { isQrIban(it) } == true,
                busy = busy,
                errors = errors,
                onDismiss = onClose,
            ) { vm.savePortfolio(dialog.portfolio?.id, it) }
        AccountDialog.PortfolioValues ->
            PortfolioValuesSheet(page.portfolios, account.currency, busy, errors, onClose) { vm.setPortfolioValues(it) }
        is AccountDialog.PortfolioHistory ->
            PortfolioHistorySheet(
                portfolio = dialog.portfolio,
                values = page.portfolioValues[dialog.portfolio.id].orEmpty(),
                currency = account.currency,
                onDismiss = onClose,
                onDelete = { onOpen(AccountDialog.DeletePortfolioValue(dialog.portfolio, it)) },
            )
        is AccountDialog.ClosePortfolio ->
            ClosePortfolioSheet(dialog.portfolio, busy, errors, onClose) { closedOn, reason ->
                vm.closePortfolio(dialog.portfolio.id, closedOn, reason)
            }
        is AccountDialog.DeletePortfolio ->
            ConfirmDialog(
                title = stringResource(R.string.accounts_delete_portfolio_title, dialog.portfolio.name),
                text = stringResource(R.string.accounts_delete_portfolio_text),
                confirmLabel = stringResource(R.string.delete),
                onConfirm = { vm.deletePortfolio(dialog.portfolio.id) },
                onDismiss = onClose,
            )
        is AccountDialog.DeletePortfolioValue ->
            ConfirmDialog(
                title = stringResource(R.string.accounts_delete_value_title),
                text = stringResource(R.string.accounts_delete_value_text, formats.date(dialog.value.date)),
                confirmLabel = stringResource(R.string.delete),
                onConfirm = { vm.deletePortfolioValue(dialog.portfolio.id, dialog.value.id) },
                onDismiss = onClose,
            )
    }
}

/** The currency of an account cannot change once it has data: transactions, balances, trades or portfolio values. */
internal fun isCurrencyLocked(page: AccountDetailPage): Boolean =
    page.account.lastBookingDate != null ||
        page.account.openingBalance != 0L ||
        page.snapshots.isNotEmpty() ||
        page.trades.isNotEmpty() ||
        page.portfolios.any { it.latestValue != null }

/** A confirmation that only accepts the exact [confirmText] typed in: for what cannot be undone. */
@Composable
internal fun TypedConfirmDialog(
    title: String,
    text: String,
    confirmText: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    var typed by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(text)
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = { Text(stringResource(R.string.accounts_type_to_confirm, confirmText)) },
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onDismiss()
                    onConfirm()
                },
                enabled = typed.trim() == confirmText,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
