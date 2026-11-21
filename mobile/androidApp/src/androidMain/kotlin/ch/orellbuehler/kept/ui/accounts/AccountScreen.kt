package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material.icons.outlined.Upload
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailCandidate
import ch.orellbuehler.kept.model.AccountDetailCandidates
import ch.orellbuehler.kept.model.AccountDetailFillResult
import ch.orellbuehler.kept.model.AccountDetailPage
import ch.orellbuehler.kept.model.AccountDetailPortfolio
import ch.orellbuehler.kept.model.AccountDetailPortfolioValue
import ch.orellbuehler.kept.model.AccountDetailSnapshot
import ch.orellbuehler.kept.model.AccountDetailTrade
import ch.orellbuehler.kept.model.AccountDetailTx
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException

/** What the "link as transfer" picker shows for the transaction it was opened on. */
sealed interface CandidatesState {
    data object Idle : CandidatesState

    data object Loading : CandidatesState

    data class Failed(
        val message: String,
    ) : CandidatesState

    data class Ready(
        val transactionId: String,
        val candidates: List<AccountDetailCandidate>,
    ) : CandidatesState
}

/** The page of one account. Each action is one call of [submit]; the data is reloaded after it. */
class AccountViewModel(
    sdk: KeptSdk,
    private val id: String,
    private val query: MutableStateFlow<TxQuery> = MutableStateFlow(TxQuery()),
) : PageViewModel<AccountDetailPage>(sdk, { it.load("accounts/$id", query.value.toParams()) }) {
    private val path = "accounts/$id"

    val txQuery: StateFlow<TxQuery> = query.asStateFlow()

    private val mutableCandidates = MutableStateFlow<CandidatesState>(CandidatesState.Idle)
    val candidates: StateFlow<CandidatesState> = mutableCandidates.asStateFlow()

    private val mutableFillResult = MutableStateFlow<AccountDetailFillResult?>(null)
    val fillResult: StateFlow<AccountDetailFillResult?> = mutableFillResult.asStateFlow()

    /** Applies the filters and goes back to the first page. */
    fun applyFilters(next: TxQuery) {
        query.value = next.copy(page = 1)
        refresh()
    }

    fun goToPage(page: Int) {
        query.value = query.value.copy(page = page.coerceAtLeast(1))
        refresh()
    }

    // Account
    fun updateAccount(
        draft: AccountDraft,
        hasPortfolios: Boolean,
        hasTrades: Boolean,
        confirmRemoveMirrors: Boolean,
    ) = submit(path, "updateAccount", draft.toForm(hasPortfolios, hasTrades, confirmRemoveMirrors))

    fun setArchived(archived: Boolean) = submit(path, if (archived) "archive" else "unarchive", showRefusal = true)

    fun deleteAccount() = submit(path, "deleteAccount", showRefusal = true)

    // Transactions
    fun addTransaction(draft: TxDraft) = submit(path, "addTransaction", draft.toForm(null, noteOnly = false))

    fun updateTransaction(
        tx: AccountDetailTx,
        draft: TxDraft,
    ) = submit(path, "updateTransaction", draft.toForm(tx.id, noteOnly = tx.source != "manual"))

    fun deleteTransaction(transactionId: String) =
        submit(path, "deleteTransaction", idForm("transactionId" to transactionId), showRefusal = true)

    fun setCategory(
        transactionId: String,
        categoryId: String?,
    ) = submit(path, "setCategory", idForm("transactionId" to transactionId, "categoryId" to categoryId.orEmpty()), showRefusal = true)

    fun setTaxYear(
        transactionId: String,
        year: String,
    ) = submit(path, "setTaxYear", idForm("transactionId" to transactionId, "taxYear" to year.trim()))

    fun setDeductionYear(
        transactionId: String,
        year: String,
    ) = submit(path, "setDeductionYear", idForm("transactionId" to transactionId, "deductionYear" to year.trim()))

    // Transfers
    fun unlinkTransfer(transactionId: String) = submit(path, "unlinkTransfer", idForm("transactionId" to transactionId), showRefusal = true)

    fun linkTransfer(
        transactionId: String,
        peerId: String,
    ) = submit(path, "linkTransfer", idForm("transactionId" to transactionId, "peerId" to peerId), showRefusal = true) { clearCandidates() }

    /** Looks for the other side of a transaction; the answer is in [candidates]. Not a form: it saves nothing. */
    fun loadCandidates(transactionId: String) {
        mutableCandidates.value = CandidatesState.Loading
        viewModelScope.launch {
            mutableCandidates.value =
                try {
                    val result = sdk.action(path, "transferCandidates", idForm("transactionId" to transactionId))
                    if (result.ok) {
                        val decoded = ApiJson.decodeFromString<AccountDetailCandidates>(result.json)
                        CandidatesState.Ready(transactionId, decoded.candidates)
                    } else {
                        CandidatesState.Failed(result.message.orEmpty())
                    }
                } catch (e: KeptException) {
                    CandidatesState.Failed(e.message.orEmpty())
                } catch (e: SerializationException) {
                    CandidatesState.Failed(e.message.orEmpty())
                }
        }
    }

    fun clearCandidates() {
        mutableCandidates.value = CandidatesState.Idle
    }

    fun resolveNeedsAmount(
        transferId: String,
        amount: String,
    ) = submit(path, "resolveNeedsAmount", idForm("transferId" to transferId, "amount" to amount))

    fun linkNeedsAmount(
        transferId: String,
        peerId: String,
    ) = submit(path, "linkNeedsAmount", idForm("transferId" to transferId, "peerId" to peerId), showRefusal = true)

    fun enableFillFromTransfers() =
        submit(path, "enableFillFromTransfers", showRefusal = true) { result ->
            mutableFillResult.value =
                try {
                    ApiJson.decodeFromString<AccountDetailFillResult>(result.json)
                } catch (e: SerializationException) {
                    AccountDetailFillResult()
                }
        }

    fun dismissFillResult() {
        mutableFillResult.value = null
    }

    // Snapshots
    fun addSnapshot(draft: SnapshotDraft) = submit(path, "addSnapshot", draft.toForm())

    fun deleteSnapshot(snapshotId: String) = submit(path, "deleteSnapshot", idForm("snapshotId" to snapshotId), showRefusal = true)

    // Holdings
    fun saveTrade(
        tradeId: String?,
        draft: TradeDraft,
    ) = submit(path, if (tradeId == null) "addTrade" else "updateTrade", draft.toForm(tradeId))

    fun deleteTrade(tradeId: String) = submit(path, "deleteTrade", idForm("tradeId" to tradeId), showRefusal = true)

    // Portfolios
    fun savePortfolio(
        portfolioId: String?,
        draft: PortfolioDraft,
    ) = submit(path, if (portfolioId == null) "addPortfolio" else "updatePortfolio", draft.toForm(portfolioId))

    fun closePortfolio(
        portfolioId: String,
        closedOn: String,
        reason: String,
    ) = submit(path, "closePortfolio", idForm("portfolioId" to portfolioId, "closedOn" to closedOn, "closeReason" to reason))

    fun reopenPortfolio(portfolioId: String) = submit(path, "reopenPortfolio", idForm("portfolioId" to portfolioId), showRefusal = true)

    fun deletePortfolio(portfolioId: String) = submit(path, "deletePortfolio", idForm("portfolioId" to portfolioId), showRefusal = true)

    fun setPortfolioValues(draft: PortfolioValuesDraft) = submit(path, "setPortfolioValues", draft.toForm())

    fun deletePortfolioValue(
        portfolioId: String,
        valueId: String,
    ) = submit(path, "deletePortfolioValue", idForm("portfolioId" to portfolioId, "valueId" to valueId), showRefusal = true)
}

/** The dialogs and sheets of the account screen: at most one is open, a transaction's detail sheet may stay open beneath it. */
internal sealed interface AccountDialog {
    data object EditAccount : AccountDialog

    data object DeleteAccount : AccountDialog

    data object AddTransaction : AccountDialog

    data class EditTransaction(
        val tx: AccountDetailTx,
    ) : AccountDialog

    data class DeleteTransaction(
        val tx: AccountDetailTx,
    ) : AccountDialog

    data object Filters : AccountDialog

    data object AddSnapshot : AccountDialog

    data class DeleteSnapshot(
        val snapshot: AccountDetailSnapshot,
    ) : AccountDialog

    data class TradeForm(
        val trade: AccountDetailTrade?,
    ) : AccountDialog

    data class DeleteTrade(
        val trade: AccountDetailTrade,
    ) : AccountDialog

    data class PortfolioForm(
        val portfolio: AccountDetailPortfolio?,
    ) : AccountDialog

    data object PortfolioValues : AccountDialog

    data class PortfolioHistory(
        val portfolio: AccountDetailPortfolio,
    ) : AccountDialog

    data class ClosePortfolio(
        val portfolio: AccountDetailPortfolio,
    ) : AccountDialog

    data class DeletePortfolio(
        val portfolio: AccountDetailPortfolio,
    ) : AccountDialog

    data class DeletePortfolioValue(
        val portfolio: AccountDetailPortfolio,
        val value: AccountDetailPortfolioValue,
    ) : AccountDialog
}

/** One account: balance, transactions with search and filters, transfers, holdings, portfolios and balance snapshots. */
@Composable
fun AccountScreen(
    id: String,
    nav: Navigator,
) {
    val vm = keptViewModel(key = "account-$id") { AccountViewModel(it, id) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var dialog by remember { mutableStateOf<AccountDialog?>(null) }
    var detailId by remember { mutableStateOf<String?>(null) }
    val page = (state as? Load.Ready)?.value

    PageScaffold(
        title = page?.account?.name ?: stringResource(R.string.nav_accounts),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event ->
            when (event) {
                UiEvent.Saved -> dialog = null
                is UiEvent.Navigate -> nav.openWebPath(event.webPath, replace = true)
                is UiEvent.Message -> Unit
            }
        },
        actions = {
            if (page != null) {
                AccountMenu(page, vm, nav) {
                    vm.clearFormErrors()
                    dialog = it
                }
            }
        },
    ) { data, padding ->
        LazyColumn(contentPadding = padding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            accountSections(
                page = data,
                vm = vm,
                nav = nav,
                onDialog = {
                    vm.clearFormErrors()
                    dialog = it
                },
                onOpenTransaction = {
                    vm.clearFormErrors()
                    detailId = it
                },
            )
        }
    }

    if (page != null) {
        val detail = detailId?.let { wanted -> page.transactions.items.firstOrNull { it.id == wanted } }
        if (detail != null) {
            TransactionSheet(
                page = page,
                tx = detail,
                vm = vm,
                nav = nav,
                onDismiss = {
                    vm.clearCandidates()
                    detailId = null
                },
                onEdit = {
                    vm.clearFormErrors()
                    dialog = AccountDialog.EditTransaction(detail)
                },
                onDelete = { dialog = AccountDialog.DeleteTransaction(detail) },
            )
        }
        AccountDialogs(page, dialog, vm, busy, errors, nav, onClose = { dialog = null }, onOpen = { dialog = it }, onTransactionGone = {
            detailId =
                null
        })
    }
}

@Composable
private fun AccountMenu(
    page: AccountDetailPage,
    vm: AccountViewModel,
    nav: Navigator,
    onDialog: (AccountDialog) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val account = page.account
    Box {
        IconButton(onClick = { open = true }) {
            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.edit)) },
                leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                onClick = {
                    open = false
                    onDialog(AccountDialog.EditAccount)
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.accounts_import_statement)) },
                leadingIcon = { Icon(Icons.Outlined.Upload, contentDescription = null) },
                onClick = {
                    open = false
                    nav.open(Routes.IMPORT)
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.accounts_import_history)) },
                leadingIcon = { Icon(Icons.Outlined.History, contentDescription = null) },
                onClick = {
                    open = false
                    nav.open(Routes.accountImports(account.id))
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.accounts_open_in_browser)) },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
                onClick = {
                    open = false
                    nav.openInBrowser("accounts/${account.id}")
                },
            )
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text(stringResource(if (account.archived) R.string.accounts_unarchive else R.string.accounts_archive)) },
                leadingIcon = {
                    Icon(if (account.archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive, contentDescription = null)
                },
                onClick = {
                    open = false
                    vm.setArchived(!account.archived)
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                leadingIcon = {
                    Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                },
                onClick = {
                    open = false
                    onDialog(AccountDialog.DeleteAccount)
                },
            )
        }
    }
}
