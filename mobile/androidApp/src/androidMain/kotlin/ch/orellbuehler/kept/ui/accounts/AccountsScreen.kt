package ch.orellbuehler.kept.ui.accounts

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountsAccount
import ch.orellbuehler.kept.model.AccountsInstitution
import ch.orellbuehler.kept.model.AccountsPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.bills.openLink
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.IconBadge
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.components.parseColor
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept

class AccountsViewModel(
    sdk: KeptSdk,
) : PageViewModel<AccountsPage>(sdk, { it.load("accounts") }) {
    fun createInstitution(draft: InstitutionDraft) = submit(PATH, "createInstitution", draft.toForm(null))

    fun updateInstitution(
        id: String,
        draft: InstitutionDraft,
    ) = submit(PATH, "updateInstitution", draft.toForm(id))

    fun deleteInstitution(id: String) = submit(PATH, "deleteInstitution", idForm("id" to id), showRefusal = true)

    fun createAccount(
        draft: AccountDraft,
        confirmRemoveMirrors: Boolean = false,
    ) = submit(PATH, "createAccount", draft.toForm(confirmRemoveMirrors = confirmRemoveMirrors))

    private companion object {
        const val PATH = "accounts"
    }
}

private sealed interface AccountsDialog {
    data class AddAccount(
        val institutionId: String,
    ) : AccountsDialog

    data object AddInstitution : AccountsDialog

    data class EditInstitution(
        val institution: AccountsInstitution,
    ) : AccountsDialog

    data class DeleteInstitution(
        val institution: AccountsInstitution,
    ) : AccountsDialog
}

/** The accounts under their institutions, with the totals per currency. */
@Composable
fun AccountsScreen(nav: Navigator) {
    val vm = keptViewModel { AccountsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var dialog by remember { mutableStateOf<AccountsDialog?>(null) }
    var showArchived by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    PageScaffold(
        title = stringResource(R.string.nav_accounts),
        state = state,
        onRefresh = vm::refresh,
        events = vm.events,
        onEvent = { event ->
            when (event) {
                UiEvent.Saved -> dialog = null
                is UiEvent.Navigate -> nav.openWebPath(event.webPath)
                is UiEvent.Message -> Unit
            }
        },
        actions = {
            Box {
                IconButton(onClick = { menu = true }) {
                    Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.add))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.accounts_add_account)) },
                        onClick = {
                            menu = false
                            vm.clearFormErrors()
                            dialog = AccountsDialog.AddAccount("")
                        },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.accounts_add_institution)) },
                        onClick = {
                            menu = false
                            vm.clearFormErrors()
                            dialog = AccountsDialog.AddInstitution
                        },
                    )
                }
            }
        },
    ) { page, padding ->
        if (page.accounts.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.AccountBalance,
                title = stringResource(R.string.accounts_welcome_title),
                text = stringResource(R.string.accounts_welcome_text),
                action = stringResource(R.string.accounts_add_account),
                onAction = { dialog = AccountsDialog.AddAccount("") },
            )
        } else {
            AccountList(page, padding, showArchived, { showArchived = it }, nav) { dialog = it }
        }
    }

    when (val current = dialog) {
        null -> Unit
        is AccountsDialog.AddAccount ->
            AccountFormSheet(
                account = null,
                institutions =
                    (state as? Load.Ready)
                        ?.value
                        ?.institutions
                        .orEmpty()
                        .map { it.id to it.name },
                defaultInstitutionId = current.institutionId,
                busy = busy,
                errors = errors,
                onDismiss = { dialog = null },
                onSubmit = { draft, _, _, confirm -> vm.createAccount(draft, confirm) },
            )
        AccountsDialog.AddInstitution ->
            InstitutionFormSheet(
                institution = null,
                busy = busy,
                errors = errors,
                onDismiss = { dialog = null },
                onSubmit = vm::createInstitution,
            )
        is AccountsDialog.EditInstitution ->
            InstitutionFormSheet(
                institution = current.institution,
                busy = busy,
                errors = errors,
                onDismiss = { dialog = null },
                onSubmit = { vm.updateInstitution(current.institution.id, it) },
            )
        is AccountsDialog.DeleteInstitution ->
            ConfirmDialog(
                title = stringResource(R.string.accounts_delete_institution, current.institution.name),
                text = stringResource(R.string.accounts_delete_institution_text),
                confirmLabel = stringResource(R.string.delete),
                onConfirm = { vm.deleteInstitution(current.institution.id) },
                onDismiss = { dialog = null },
            )
    }
}

@Composable
private fun AccountList(
    page: AccountsPage,
    padding: PaddingValues,
    showArchived: Boolean,
    onShowArchived: (Boolean) -> Unit,
    nav: Navigator,
    onDialog: (AccountsDialog) -> Unit,
) {
    val archivedCount = page.accounts.count { it.archived }
    val totals = currencyTotals(page.accounts)
    val groups = groupByInstitution(page.institutions, page.accounts, showArchived)
    val now = remember { System.currentTimeMillis() }
    LazyColumn(contentPadding = padding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (totals.isNotEmpty()) {
            item(key = "totals") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    totals.forEach { total ->
                        SectionCard(title = stringResource(R.string.accounts_total, total.currency)) {
                            AmountText(
                                total.sum,
                                total.currency,
                                tone = AmountTone.NEGATIVE,
                                style = MaterialTheme.typography.headlineMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                            if (total.shared) {
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(
                                        stringResource(R.string.accounts_my_share),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    AmountText(total.share, total.currency, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                    Text(
                        stringResource(R.string.accounts_totals_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        if (archivedCount > 0) {
            item(key = "archived") {
                SwitchRow(
                    title = stringResource(R.string.accounts_show_archived, archivedCount),
                    checked = showArchived,
                    onCheckedChange = onShowArchived,
                )
            }
        }
        if (groups.all { it.accounts.isEmpty() } && page.institutions.isEmpty()) {
            item(key = "all-archived") {
                Text(
                    stringResource(R.string.accounts_all_archived),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(groups, key = { it.institution?.id ?: "other" }) { group ->
            InstitutionSection(group, now, nav, onDialog)
        }
    }
}

@Composable
private fun InstitutionSection(
    group: InstitutionGroup,
    now: Long,
    nav: Navigator,
    onDialog: (AccountsDialog) -> Unit,
) {
    val institution = group.institution
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    institution?.name ?: stringResource(R.string.accounts_other),
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                )
                if (institution?.bic != null) {
                    Text(
                        institution.bic,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (institution?.websiteUrl != null) {
                val context = LocalContext.current
                IconButton(onClick = { openWebsite(context, institution.websiteUrl) }) {
                    Icon(
                        Icons.AutoMirrored.Outlined.OpenInNew,
                        contentDescription = stringResource(R.string.accounts_open_institution_website, institution.name),
                    )
                }
            }
            if (institution != null) InstitutionMenu(institution, onDialog)
        }
        if (group.accounts.isEmpty()) {
            Text(
                stringResource(
                    if (institution != null && institution.accountCount > 0) {
                        R.string.accounts_group_all_archived
                    } else {
                        R.string.accounts_group_empty
                    },
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            SectionCard(contentPadding = false) {
                group.accounts.forEachIndexed { index, account ->
                    if (index > 0) RowDivider()
                    AccountRow(account, now) { nav.open(Routes.account(account.id)) }
                }
            }
        }
    }
}

@Composable
private fun InstitutionMenu(
    institution: AccountsInstitution,
    onDialog: (AccountsDialog) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.accounts_institution_actions, institution.name))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.accounts_add_account)) },
                leadingIcon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                onClick = {
                    open = false
                    onDialog(AccountsDialog.AddAccount(institution.id))
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.edit)) },
                leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                onClick = {
                    open = false
                    onDialog(AccountsDialog.EditInstitution(institution))
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                onClick = {
                    open = false
                    onDialog(AccountsDialog.DeleteInstitution(institution))
                },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccountRow(
    account: AccountsAccount,
    now: Long,
    onClick: () -> Unit,
) {
    val formats = LocalFormats.current
    val ibanMode = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    val iban = account.iban?.let { displayIban(it, ibanMode) }
    val topUpIban = account.depositIban?.takeIf { account.type != "pillar_3a" }?.let { displayIban(it, ibanMode) }
    val stale = staleImportDays(account.lastImportAt, account.lastCheckedAt, now)
    val website = websiteOf(account)
    val context = LocalContext.current
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconBadge(Icons.Outlined.AccountBalance, tint = parseColor(account.institution?.color, MaterialTheme.colorScheme.primary))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(account.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 2)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                AccountBadges(account)
            }
            if (iban != null) {
                Text(iban, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (topUpIban != null) {
                Text(
                    stringResource(R.string.accounts_top_up_via, topUpIban),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                if (account.lastBookingDate != null) {
                    stringResource(R.string.accounts_last_booking, formats.date(account.lastBookingDate))
                } else {
                    stringResource(R.string.accounts_no_transactions)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (stale != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(
                        Icons.Outlined.WarningAmber,
                        contentDescription = null,
                        tint = MaterialTheme.kept.warning,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        lastFreshLabel(account.lastImportAt, account.lastCheckedAt, daysAgo(stale)),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.kept.warning,
                    )
                }
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            AmountText(account.balance, account.currency, tone = AmountTone.NEGATIVE, style = MaterialTheme.typography.titleMedium)
            if (account.shareBps < FULL_SHARE_BPS) {
                Text(
                    stringResource(R.string.accounts_my_share),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AmountText(account.shareBalance, account.currency, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (website != null) {
            IconButton(onClick = { openWebsite(context, website) }, modifier = Modifier.size(36.dp)) {
                Icon(
                    Icons.AutoMirrored.Outlined.OpenInNew,
                    contentDescription = stringResource(R.string.accounts_open_website, account.name),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** Opens a portal link in the browser, and says so when the phone has none. */
internal fun openWebsite(
    context: Context,
    url: String,
) {
    if (!openLink(context, url)) Toast.makeText(context, R.string.accounts_no_browser, Toast.LENGTH_SHORT).show()
}

/** "Last import 3 months ago", or "Last checked …" when the user confirmed there was nothing new to import since. */
@Composable
internal fun lastFreshLabel(
    lastImportAt: Long?,
    lastCheckedAt: Long?,
    ago: String,
): String =
    stringResource(
        if (checkedAfterImport(lastImportAt, lastCheckedAt)) R.string.accounts_last_checked else R.string.accounts_last_import,
        ago,
    )

/** "3 months ago" style text for a number of days, in plural-aware resources. */
@Composable
internal fun daysAgo(days: Int): String =
    when {
        days < 60 -> pluralStringResource(R.plurals.accounts_days_ago, days, days)
        days < 730 -> pluralStringResource(R.plurals.accounts_months_ago, (days / 30.4).toInt(), (days / 30.4).toInt())
        else -> pluralStringResource(R.plurals.accounts_years_ago, days / 365, days / 365)
    }

@Composable
internal fun AccountBadges(account: AccountsAccount) {
    val formats = LocalFormats.current
    Pill(stringResource(accountTypeLabel(account.type)))
    if (account.shareBps < FULL_SHARE_BPS) {
        Pill(stringResource(R.string.accounts_shared_badge, formatShare(account.shareBps)))
    }
    val notice = account.noticeMonths
    if (notice != null) {
        val free = account.freeWithdrawal
        val period = account.freeWithdrawalPeriod
        val blurred = LocalSession.current?.preferences?.blurAmounts == true
        val text =
            if (free != null && period != null && !blurred) {
                stringResource(
                    R.string.accounts_notice_free,
                    pluralStringResource(R.plurals.accounts_notice, notice, notice),
                    formats.money(free, account.currency),
                    stringResource(if (period == "month") R.string.accounts_period_month_lower else R.string.accounts_period_year_lower),
                )
            } else {
                pluralStringResource(R.plurals.accounts_notice, notice, notice)
            }
        Pill(text)
    }
    if (account.archived) Pill(stringResource(R.string.accounts_archived))
}
