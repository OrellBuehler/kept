package ch.orellbuehler.kept.ui.reports

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ReportAccount
import ch.orellbuehler.kept.model.ReportsPage
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import java.io.File

/** PDF reports the server builds: pick the options, download, open or share. */
@Composable
fun ReportsScreen(nav: Navigator) {
    val vm = keptViewModel { ReportsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val working by vm.working.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val directory = remember { File(context.cacheDir, DOCUMENTS_DIR) }
    var last by remember { mutableStateOf<File?>(null) }
    val noViewer = stringResource(R.string.reports_no_viewer)
    val openTitle = stringResource(R.string.reports_open_title)
    val shareTitle = stringResource(R.string.reports_share_title)

    LaunchedEffect(vm) {
        vm.downloaded.collect { file ->
            last = file
            if (!openPdf(context, file, openTitle)) vm.notify(noViewer)
        }
    }

    PageScaffold(
        title = stringResource(R.string.reports_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { if (it is UiEvent.Navigate) nav.openWebPath(it.webPath, replace = true) },
    ) { page, padding ->
        val failedPrefix = stringResource(R.string.reports_failed, "").trim()
        val download = { kind: ReportKind, query: Map<String, String> -> vm.download(kind, query, directory, failedPrefix) }
        ScrollColumn(padding) {
            Text(
                stringResource(R.string.reports_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (working != null) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(stringResource(R.string.reports_working), style = MaterialTheme.typography.bodySmall)
            }
            last?.let { file ->
                SectionCard(title = stringResource(R.string.reports_last_title), subtitle = file.name) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { if (!openPdf(context, file, openTitle)) vm.notify(noViewer) }) {
                            Text(stringResource(R.string.reports_open))
                        }
                        OutlinedButton(
                            onClick = {
                                if (!sharePdf(
                                        context,
                                        file,
                                        shareTitle,
                                    )
                                ) {
                                    vm.notify(noViewer)
                                }
                            },
                        ) {
                            Icon(Icons.Outlined.Share, contentDescription = null)
                            Text(stringResource(R.string.reports_share), modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
            }
            StatementCard(page, working == null, download, onAccounts = { nav.open(Routes.ACCOUNTS) })
            SimpleCard(
                stringResource(R.string.reports_bills_title),
                stringResource(R.string.reports_bills_text),
            ) {
                DownloadButton(
                    stringResource(R.string.reports_download),
                    working == null,
                    outlined = true,
                ) { download(ReportKind.BILLS, emptyMap()) }
            }
            SimpleCard(
                stringResource(R.string.reports_net_worth_title),
                stringResource(R.string.reports_net_worth_text) +
                    if (page.hasShared) " " + stringResource(R.string.reports_net_worth_shared) else "",
            ) {
                DownloadButton(
                    stringResource(if (page.hasShared) R.string.reports_download_total else R.string.reports_download),
                    working == null,
                    outlined = true,
                ) { download(ReportKind.NET_WORTH, netWorthQuery(false)) }
                if (page.hasShared) {
                    DownloadButton(stringResource(R.string.reports_download_share), working == null, outlined = true) {
                        download(ReportKind.NET_WORTH, netWorthQuery(true))
                    }
                }
            }
            YearCard(ReportKind.TAX, R.string.reports_tax_title, R.string.reports_tax_text, page.today, working == null, download)
            YearCard(
                ReportKind.TAX_DEDUCTIONS,
                R.string.reports_tax_deductions_title,
                R.string.reports_tax_deductions_text,
                page.today,
                working == null,
                download,
            )
        }
    }
}

@Composable
private fun SimpleCard(
    title: String,
    text: String,
    content: @Composable () -> Unit,
) {
    SectionCard(title = title, subtitle = text) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier) { content() }
    }
}

@Composable
private fun DownloadButton(
    label: String,
    enabled: Boolean,
    outlined: Boolean = false,
    onClick: () -> Unit,
) {
    val content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        Icon(Icons.Outlined.Download, contentDescription = null)
        Text(label, modifier = Modifier.padding(start = 6.dp), maxLines = 1)
    }
    if (outlined) {
        OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            content = content,
        )
    } else {
        Button(onClick = onClick, enabled = enabled, content = content)
    }
}

@Composable
private fun YearCard(
    kind: ReportKind,
    title: Int,
    text: Int,
    today: String,
    enabled: Boolean,
    download: (ReportKind, Map<String, String>) -> Unit,
) {
    var year by rememberSaveable(kind.path) { mutableStateOf(today.take(4)) }
    val parsed = parseYear(year)
    SectionCard(title = stringResource(title), subtitle = stringResource(text)) {
        FormTextField(
            label = stringResource(R.string.reports_year),
            value = year,
            onValueChange = { year = it.filter(Char::isDigit).take(4) },
            error = if (year.isNotEmpty() && parsed == null && year.length == 4) stringResource(R.string.reports_year_invalid) else null,
            keyboardType = androidx.compose.ui.text.input.KeyboardType.Number,
        )
        DownloadButton(stringResource(R.string.reports_download), enabled && parsed != null, outlined = true) {
            parsed?.let { download(kind, yearQuery(it)) }
        }
    }
}

@Composable
private fun StatementCard(
    page: ReportsPage,
    enabled: Boolean,
    download: (ReportKind, Map<String, String>) -> Unit,
    onAccounts: () -> Unit,
) {
    val ibanMode = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    val initial = remember(page.today) { lastFullMonth(page.today) }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var accountId by rememberSaveable { mutableStateOf("") }
    var from by rememberSaveable { mutableStateOf(initial.first) }
    var to by rememberSaveable { mutableStateOf(initial.second) }
    val visible = visibleAccounts(page.accounts, showArchived)
    val selected = if (visible.any { it.id == accountId }) accountId else visible.singleOrNull()?.id.orEmpty()
    val archivedLabel = stringResource(R.string.reports_archived_suffix)
    SectionCard(title = stringResource(R.string.reports_statement_title), subtitle = stringResource(R.string.reports_statement_text)) {
        if (page.accounts.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.AccountBalance,
                title = stringResource(R.string.reports_no_accounts_title),
                text = stringResource(R.string.reports_no_accounts_text),
                modifier = Modifier,
                action = stringResource(R.string.reports_go_accounts),
                onAction = onAccounts,
            )
            return@SectionCard
        }
        ChoiceField(
            label = stringResource(R.string.reports_account),
            options =
                listOf(Choice("", stringResource(R.string.reports_choose_account))) +
                    visible.map { Choice(it.id, accountLabel(it, ibanMode, archivedLabel)) },
            selected = selected,
            onSelect = { accountId = it },
        )
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
            Text(stringResource(R.string.reports_show_archived), modifier = Modifier.weight(1f))
            Switch(checked = showArchived, onCheckedChange = { showArchived = it })
        }
        DateField(label = stringResource(R.string.reports_from), value = from, onValueChange = { from = it })
        DateField(
            label = stringResource(R.string.reports_to),
            value = to,
            onValueChange = { to = it },
            error = if (rangeInvalid(from, to)) stringResource(R.string.reports_range_invalid) else null,
        )
        DownloadButton(stringResource(R.string.reports_download), enabled && canDownloadStatement(visible, selected, from, to)) {
            download(ReportKind.STATEMENT, statementQuery(selected, from, to))
        }
    }
}

private fun accountLabel(
    account: ReportAccount,
    ibanMode: String,
    archivedLabel: String,
): String =
    buildString {
        append(account.name).append(" (").append(account.currency).append(')')
        ibanLabel(account.iban, ibanMode)?.let { append(" · ").append(it) }
        if (account.archived) append(" · ").append(archivedLabel)
    }
