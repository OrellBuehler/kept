package ch.orellbuehler.kept.ui.imports

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ImportInbox
import ch.orellbuehler.kept.model.ImportInboxEntry
import ch.orellbuehler.kept.model.ImportPage
import ch.orellbuehler.kept.model.ImportRecent
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.IconBadge
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SectionHeader
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.launch

class ImportViewModel(
    sdk: KeptSdk,
) : PageViewModel<ImportPage>(sdk, { it.load("import") }) {
    /** Sends the file; the page answers with where the flow continues (the mapping or the preview). */
    fun upload(
        accountId: String,
        file: ImportFileRead.Ready,
    ) {
        submit(
            "import",
            "upload",
            FormBody().set("accountId", accountId).file("file", file.name, file.type, file.base64),
            reload = false,
        )
    }

    fun reviewInbox(entryId: String) {
        submit("import", "reviewInbox", FormBody().set("entryId", entryId), showRefusal = true, reload = false)
    }

    fun notify(text: String) = message(text)
}

/** Choose an account and a statement file; the server reads it and the preview opens. */
@Composable
fun ImportScreen(nav: Navigator) {
    val vm = keptViewModel { ImportViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    PageScaffold(
        title = stringResource(R.string.imports_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event -> if (event is UiEvent.Navigate) nav.openWebPath(event.webPath, replace = true) },
    ) { page, padding ->
        ScrollColumn(padding) {
            if (page.accounts.isEmpty()) {
                SectionCard {
                    MessagePane(
                        icon = Icons.Outlined.AccountBalance,
                        title = stringResource(R.string.imports_no_accounts_title),
                        text = stringResource(R.string.imports_no_accounts_text),
                        action = stringResource(R.string.imports_go_accounts),
                        onAction = { nav.open(Routes.ACCOUNTS) },
                        modifier = Modifier.padding(0.dp),
                    )
                }
            } else {
                UploadCard(page, vm, busy, errors)
            }
            if (page.inbox.enabled) InboxSection(page.inbox, busy, vm::reviewInbox)
            RecentSection(page.recentImports, nav)
        }
    }
}

@Composable
private fun UploadCard(
    page: ImportPage,
    vm: ImportViewModel,
    busy: Boolean,
    errors: Map<String, String>,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var accountId by rememberSaveable { mutableStateOf(initialAccountId(page.accounts, page.selectedAccountId)) }
    var fileUri by rememberSaveable { mutableStateOf<String?>(null) }
    var fileName by rememberSaveable { mutableStateOf("") }
    var fileSize by rememberSaveable { mutableLongStateOf(-1L) }
    var clientError by rememberSaveable { mutableStateOf<String?>(null) }
    var reading by rememberSaveable { mutableStateOf(false) }

    val unreadable = stringResource(R.string.imports_file_unreadable)
    val missing = stringResource(R.string.imports_file_missing)

    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) return@rememberLauncherForActivityResult
            scope.launch {
                val picked = describeFile(context, uri)
                if (picked == null) {
                    clientError = unreadable
                } else {
                    fileUri = picked.uri
                    fileName = picked.name
                    fileSize = picked.size
                    clientError = if (picked.size > MAX_IMPORT_BYTES) tooLargeText(picked.size, context) else null
                }
            }
        }

    fun upload() {
        val uri = fileUri
        if (uri == null) {
            clientError = missing
            return
        }
        reading = true
        scope.launch {
            try {
                when (val read = readImportFile(context, PickedFile(uri, fileName, fileSize))) {
                    is ImportFileRead.Ready -> vm.upload(accountId, read)
                    ImportFileRead.TooLarge -> clientError = tooLargeText(fileSize, context)
                    ImportFileRead.Unreadable -> clientError = unreadable
                }
            } finally {
                reading = false
            }
        }
    }

    val working = busy || reading
    val account = page.accounts.firstOrNull { it.id == accountId }
    val fileError = clientError ?: errors["file"]
    SectionCard(title = stringResource(R.string.imports_upload_title), subtitle = stringResource(R.string.imports_upload_text)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ChoiceField(
                label = stringResource(R.string.imports_account),
                options = accountChoices(page.accounts),
                selected = accountId,
                onSelect = { accountId = it },
                error = errors["accountId"],
                enabled = !working,
            )
            if (fileUri != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    IconBadge(Icons.Outlined.Description)
                    Column(Modifier.weight(1f)) {
                        Text(fileName, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
                        if (fileSize >= 0) {
                            Text(
                                formatBytes(fileSize),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    IconButton(
                        onClick = {
                            fileUri = null
                            fileName = ""
                            fileSize = -1
                            clientError = null
                        },
                        enabled = !working,
                    ) { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.imports_remove_file)) }
                }
            }
            OutlinedButton(
                onClick = {
                    clientError = null
                    picker.launch(arrayOf("*/*"))
                },
                enabled = !working,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.FolderOpen, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(
                    stringResource(if (fileUri == null) R.string.imports_choose_file else R.string.imports_change_file),
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            if (fileError != null) Text(fileError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            if (fileUri == null && fileError == null) {
                Text(
                    stringResource(R.string.imports_file_hint, MAX_IMPORT_BYTES / (1024 * 1024)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            errors["form"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(
                onClick = ::upload,
                enabled = !working && accountId.isNotEmpty() && fileUri != null && clientError == null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (working) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    Text(
                        stringResource(if (reading) R.string.imports_reading else R.string.imports_uploading),
                        modifier = Modifier.padding(start = 8.dp),
                    )
                } else {
                    Icon(Icons.Outlined.UploadFile, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.imports_upload), modifier = Modifier.padding(start = 8.dp))
                }
            }
            if (account != null) {
                Text(
                    stringResource(R.string.imports_importing_into, account.name),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun tooLargeText(
    size: Long,
    context: android.content.Context,
): String = context.getString(R.string.imports_file_too_large, formatBytes(size), MAX_IMPORT_BYTES / (1024 * 1024), SERVER_IMPORT_LIMIT_MB)

@Composable
private fun InboxSection(
    inbox: ImportInbox,
    busy: Boolean,
    onReview: (String) -> Unit,
) {
    val formats = LocalFormats.current
    SectionHeader(stringResource(R.string.imports_inbox_title))
    SectionCard {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.imports_inbox_text), style = MaterialTheme.typography.bodyMedium)
            val scan = inbox.lastScan
            Text(
                if (scan != null) {
                    stringResource(R.string.imports_inbox_last_scan, formatDateTime(scan.at, formats.locale))
                } else {
                    stringResource(R.string.imports_inbox_no_scan)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    if (inbox.entries.isEmpty()) {
        Text(
            stringResource(R.string.imports_inbox_empty),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
    } else {
        SectionCard(contentPadding = false) {
            inbox.entries.forEachIndexed { index, entry ->
                if (index > 0) RowDivider()
                InboxRow(entry, busy, onReview)
            }
        }
    }
}

@Composable
private fun InboxRow(
    entry: ImportInboxEntry,
    busy: Boolean,
    onReview: (String) -> Unit,
) {
    val formats = LocalFormats.current
    val status = InboxStatus.fromApi(entry.status)
    val (label, color) =
        when (status) {
            InboxStatus.IMPORTED -> R.string.imports_inbox_imported to MaterialTheme.kept.positive
            InboxStatus.REVIEW -> R.string.imports_inbox_review_status to MaterialTheme.kept.warning
            InboxStatus.FAILED -> R.string.imports_inbox_failed to MaterialTheme.kept.negative
            InboxStatus.DUPLICATE -> R.string.imports_inbox_duplicate to MaterialTheme.colorScheme.onSurfaceVariant
        }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(entry.fileName, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 2)
            Pill(stringResource(label), color = color)
        }
        val detail =
            when {
                status == InboxStatus.IMPORTED -> stringResource(R.string.imports_counts, entry.newCount ?: 0, entry.duplicateCount ?: 0)
                else -> entry.reason
            }
        val line = listOfNotNull(entry.accountName, detail).joinToString(" · ")
        if (line.isNotEmpty()) {
            Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                formatDateTime(entry.updatedAt, formats.locale),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            if (status == InboxStatus.REVIEW) {
                TextButton(onClick = { onReview(entry.id) }, enabled = !busy) { Text(stringResource(R.string.imports_inbox_review)) }
            }
        }
    }
}

@Composable
private fun RecentSection(
    recent: List<ImportRecent>,
    nav: Navigator,
) {
    SectionHeader(stringResource(R.string.imports_recent_title))
    if (recent.isEmpty()) {
        Text(
            stringResource(R.string.imports_recent_empty),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
        return
    }
    SectionCard(contentPadding = false) {
        recent.forEachIndexed { index, item ->
            if (index > 0) RowDivider()
            RecentRow(item, nav)
        }
    }
}

@Composable
private fun RecentRow(
    item: ImportRecent,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    val period = formatPeriod(item.statementFrom, item.statementTo, formats) ?: stringResource(R.string.imports_no_period)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(item.fileName, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 2)
            Pill(formatName(item.format))
        }
        if (item.warnings.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(
                    Icons.Outlined.WarningAmber,
                    contentDescription = null,
                    tint = MaterialTheme.kept.warning,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    pluralStringResource(R.plurals.imports_warnings, item.warnings.size, item.warnings.size),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.kept.warning,
                )
            }
        }
        Text(
            listOf(
                item.accountName,
                period,
                stringResource(R.string.imports_counts, item.newCount, item.duplicateCount),
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                formatDateTime(item.createdAt, formats.locale),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { nav.open(Routes.accountImports(item.accountId)) }) { Text(stringResource(R.string.imports_history)) }
        }
    }
}
