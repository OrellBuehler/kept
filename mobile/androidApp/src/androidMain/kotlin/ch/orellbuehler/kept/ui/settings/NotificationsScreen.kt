package ch.orellbuehler.kept.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.NotificationSettingsChannel
import ch.orellbuehler.kept.model.NotificationSettingsPage
import ch.orellbuehler.kept.model.NotificationSettingsTest
import ch.orellbuehler.kept.model.NotificationSettingsTestAnswer
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.imports.formatDateTime
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.theme.kept

private const val PAGE = "settings/notifications"

class NotificationsViewModel(
    sdk: KeptSdk,
) : PageViewModel<NotificationSettingsPage>(sdk, { it.load(PAGE) }) {
    fun saveTriggers(
        values: TriggerFormValues,
        savedMessage: String,
    ) {
        submit(PAGE, "saveSettings", form(values.fields())) { message(savedMessage) }
    }

    fun saveChannel(
        kind: String,
        values: ChannelFormValues,
        savedMessage: String,
    ) {
        submit(PAGE, "saveChannel", form(values.fields(kind))) { message(savedMessage) }
    }

    fun toggleChannel(
        kind: String,
        enabled: Boolean,
    ) {
        submit(PAGE, "toggleChannel", form(listOf("kind" to kind, "enabled" to enabled.toString())), showRefusal = true)
    }

    fun deleteChannel(
        kind: String,
        removedMessage: String,
    ) {
        submit(PAGE, "deleteChannel", form(listOf("kind" to kind)), showRefusal = true) { message(removedMessage) }
    }

    /** Sends a test message; [describe] turns the server's answer into the message to show. */
    fun testChannel(
        kind: String,
        describe: (NotificationSettingsTest) -> String,
    ) {
        submit(PAGE, "testChannel", form(listOf("kind" to kind)), showRefusal = true) { response ->
            val answer = runCatching { ApiJson.decodeFromString<NotificationSettingsTestAnswer>(response.json) }.getOrNull()
            if (answer != null) message(describe(answer.result))
        }
    }

    private fun form(fields: List<Pair<String, String>>): FormBody {
        val body = FormBody()
        fields.forEach { (name, value) -> body.set(name, value) }
        return body
    }
}

/** The server's own notification channels (ntfy, webhook, email) and what triggers them; not the reminders of this device. */
@Composable
fun NotificationsScreen(nav: Navigator) {
    val vm = keptViewModel { NotificationsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var scope by remember { mutableStateOf<String?>(null) }
    var removeKind by rememberSaveable { mutableStateOf<String?>(null) }
    PageScaffold(
        title = stringResource(R.string.notification_settings_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
    ) { page, padding ->
        val savedTriggers = stringResource(R.string.notification_settings_triggers_saved)
        val saved = stringResource(R.string.notification_settings_saved)
        val removed = stringResource(R.string.notification_settings_removed)
        val testSent = stringResource(R.string.notification_settings_test_sent)
        val testFailed = stringResource(R.string.notification_settings_test_failed)
        ScrollColumn(padding) {
            TriggersCard(
                page = page,
                busy = busy,
                saving = busy && scope == TRIGGERS,
                errors = if (scope == TRIGGERS) errors else emptyMap(),
                onSave = {
                    scope = TRIGGERS
                    vm.saveTriggers(it, savedTriggers)
                },
            )
            shownKinds(page.kinds, page.channels).forEach { kind ->
                ChannelCard(
                    kind = kind,
                    channel = channelOf(kind, page.channels),
                    lock = channelLock(kind, page.emailBlocked),
                    busy = busy,
                    working = if (scope?.startsWith("$kind:") == true && busy) scope?.substringAfter(':') else null,
                    errors = if (scope?.startsWith("$kind:") == true) errors else emptyMap(),
                    onSave = { values ->
                        scope = "$kind:save"
                        vm.saveChannel(kind, values, saved)
                    },
                    onTest = {
                        scope = "$kind:test"
                        vm.testChannel(kind) { testMessage(it, testSent, testFailed) }
                    },
                    onToggle = { enabled ->
                        scope = "$kind:toggle"
                        vm.toggleChannel(kind, enabled)
                    },
                    onRemove = { removeKind = kind },
                )
            }
            if (emailUnavailable(page.kinds, page.emailBlocked, page.channels)) {
                Text(
                    stringResource(R.string.notification_settings_email_unavailable),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        removeKind?.let { kind ->
            ConfirmDialog(
                title = stringResource(R.string.notification_settings_remove_title, channelName(kind)),
                text = stringResource(R.string.notification_settings_remove_text),
                confirmLabel = stringResource(R.string.notification_settings_remove),
                onConfirm = {
                    scope = "$kind:remove"
                    vm.deleteChannel(kind, removed)
                },
                onDismiss = { removeKind = null },
            )
        }
    }
}

private const val TRIGGERS = "triggers"

@Composable
private fun channelName(kind: String): String =
    when (kind) {
        "ntfy" -> "ntfy"
        "webhook" -> stringResource(R.string.notification_settings_webhook)
        else -> stringResource(R.string.notification_settings_email)
    }

@Composable
private fun TriggersCard(
    page: NotificationSettingsPage,
    busy: Boolean,
    saving: Boolean,
    errors: Map<String, String>,
    onSave: (TriggerFormValues) -> Unit,
) {
    val initial = TriggerFormValues.of(page.settings)
    var billDue by rememberSaveable { mutableStateOf(initial.billDueEnabled) }
    var billDueDays by rememberSaveable { mutableStateOf(initial.billDueDays) }
    var overdue by rememberSaveable { mutableStateOf(initial.billOverdueEnabled) }
    var budget by rememberSaveable { mutableStateOf(initial.budgetEnabled) }
    var budgetPercent by rememberSaveable { mutableStateOf(initial.budgetPercent) }
    var stale by rememberSaveable { mutableStateOf(initial.staleImportEnabled) }
    var staleDays by rememberSaveable { mutableStateOf(initial.staleImportDays) }
    SectionCard(
        title = stringResource(R.string.notification_settings_triggers),
        subtitle = stringResource(R.string.notification_settings_triggers_text),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SwitchRow(stringResource(R.string.notification_settings_bill_due), billDue, { billDue = it })
            FormTextField(
                label = stringResource(R.string.notification_settings_bill_due_days),
                value = billDueDays,
                onValueChange = { billDueDays = it.filter { c -> c.isDigit() }.take(4) },
                error = errors["billDueDays"],
                keyboardType = KeyboardType.Number,
            )
            SwitchRow(stringResource(R.string.notification_settings_bill_overdue), overdue, { overdue = it })
            SwitchRow(stringResource(R.string.notification_settings_budget), budget, { budget = it })
            FormTextField(
                label = stringResource(R.string.notification_settings_budget_percent),
                value = budgetPercent,
                onValueChange = { budgetPercent = it.filter { c -> c.isDigit() }.take(4) },
                error = errors["budgetPercent"],
                keyboardType = KeyboardType.Number,
            )
            SwitchRow(stringResource(R.string.notification_settings_stale), stale, { stale = it })
            FormTextField(
                label = stringResource(R.string.notification_settings_stale_days),
                value = staleDays,
                onValueChange = { staleDays = it.filter { c -> c.isDigit() }.take(4) },
                error = errors["staleImportDays"],
                keyboardType = KeyboardType.Number,
            )
            errors["form"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(
                onClick = { onSave(TriggerFormValues(billDue, billDueDays, overdue, budget, budgetPercent, stale, staleDays)) },
                enabled = !busy,
            ) {
                if (saving) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(R.string.notification_settings_save_triggers))
                }
            }
        }
    }
}

@Composable
private fun ChannelCard(
    kind: String,
    channel: NotificationSettingsChannel?,
    lock: ChannelLock,
    busy: Boolean,
    working: String?,
    errors: Map<String, String>,
    onSave: (ChannelFormValues) -> Unit,
    onTest: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onRemove: () -> Unit,
) {
    val initial = ChannelFormValues.of(channel)
    var serverUrl by rememberSaveable(kind) { mutableStateOf(initial.serverUrl) }
    var topic by rememberSaveable(kind) { mutableStateOf(initial.topic) }
    var token by rememberSaveable(kind) { mutableStateOf("") }
    var url by rememberSaveable(kind) { mutableStateOf(initial.url) }
    var secret by rememberSaveable(kind) { mutableStateOf("") }
    var to by rememberSaveable(kind) { mutableStateOf(initial.to) }
    var removeSecret by rememberSaveable(kind) { mutableStateOf(false) }
    val values = ChannelFormValues(serverUrl, topic, token, url, secret, to, removeSecret)
    val formats = LocalFormats.current
    SectionCard(
        title = channelName(kind),
        subtitle =
            stringResource(
                when (kind) {
                    "ntfy" -> R.string.notification_settings_ntfy_text
                    "webhook" -> R.string.notification_settings_webhook_text
                    else -> R.string.notification_settings_email_text
                },
            ),
        trailing = {
            if (channel != null) {
                when (channelStatus(channel)) {
                    ChannelStatus.NEEDS_REENTRY ->
                        Pill(stringResource(R.string.notification_settings_needs_reentry), color = MaterialTheme.colorScheme.error)
                    ChannelStatus.ENABLED ->
                        Pill(
                            stringResource(R.string.notification_settings_enabled),
                            color = MaterialTheme.kept.positive,
                        )
                    ChannelStatus.PAUSED -> Pill(stringResource(R.string.notification_settings_paused))
                }
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (channel?.needsReentry == true) {
                Text(
                    stringResource(R.string.notification_settings_reentry_text),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (lock != ChannelLock.NONE) {
                Text(
                    stringResource(
                        if (lock ==
                            ChannelLock.ADMIN
                        ) {
                            R.string.notification_settings_email_admins
                        } else {
                            R.string.notification_settings_email_smtp
                        },
                    ),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                when (kind) {
                    "ntfy" -> {
                        FormTextField(
                            label = stringResource(R.string.notification_settings_server),
                            value = serverUrl,
                            onValueChange = { serverUrl = it },
                            error = errors["serverUrl"],
                            placeholder = "https://ntfy.sh",
                            keyboardType = KeyboardType.Uri,
                        )
                        FormTextField(
                            label = stringResource(R.string.notification_settings_topic),
                            value = topic,
                            onValueChange = { topic = it },
                            error = errors["topic"],
                        )
                        FormTextField(
                            label = stringResource(R.string.notification_settings_token),
                            value = token,
                            onValueChange = { token = it },
                            error = errors["token"],
                            hint = stringResource(secretHint(channel)),
                            password = true,
                        )
                    }
                    "webhook" -> {
                        FormTextField(
                            label = stringResource(R.string.notification_settings_url),
                            value = url,
                            onValueChange = { url = it },
                            error = errors["url"],
                            placeholder = "https://example.org/hooks/kept",
                            keyboardType = KeyboardType.Uri,
                        )
                        FormTextField(
                            label = stringResource(R.string.notification_settings_secret),
                            value = secret,
                            onValueChange = { secret = it },
                            error = errors["secret"],
                            hint = stringResource(secretHint(channel)),
                            password = true,
                        )
                    }
                    else ->
                        FormTextField(
                            label = stringResource(R.string.notification_settings_to),
                            value = to,
                            onValueChange = { to = it },
                            error = errors["to"],
                            keyboardType = KeyboardType.Email,
                        )
                }
                if (kind != "email" && (channel?.hasSecret == true || channel?.needsReentry == true)) {
                    SwitchRow(
                        title = stringResource(R.string.notification_settings_remove_secret),
                        checked = removeSecret,
                        onCheckedChange = { removeSecret = it },
                    )
                }
                errors["form"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                Button(onClick = { onSave(values) }, enabled = !busy && values.complete(kind)) {
                    if (working == "save") {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    } else {
                        Text(
                            stringResource(
                                when {
                                    channel == null -> R.string.notification_settings_add
                                    channel.needsReentry -> R.string.notification_settings_save_again
                                    else -> R.string.notification_settings_save_changes
                                },
                            ),
                        )
                    }
                }
            }
            if (channel != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (lock == ChannelLock.NONE) {
                            OutlinedButton(onClick = onTest, enabled = !busy && !channel.needsReentry) {
                                if (working == "test") {
                                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                } else {
                                    Text(stringResource(R.string.notification_settings_send_test))
                                }
                            }
                        }
                        TextButton(onClick = onRemove, enabled = !busy) {
                            Text(stringResource(R.string.notification_settings_remove), color = MaterialTheme.colorScheme.error)
                        }
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.notification_settings_enabled),
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f),
                        )
                        Switch(checked = channel.enabled, onCheckedChange = onToggle, enabled = !busy)
                    }
                    DeliveryStatus(channel, formats.locale)
                }
            }
        }
    }
}

@Composable
private fun DeliveryStatus(
    channel: NotificationSettingsChannel,
    locale: java.util.Locale,
) {
    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            stringResource(
                R.string.notification_settings_last_delivery,
                channel.lastSuccessAt?.let { formatDateTime(it, locale) } ?: stringResource(R.string.notification_settings_never),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!channel.lastError.isNullOrEmpty() && channel.lastErrorAt != null) {
            Text(
                stringResource(R.string.notification_settings_last_error, channel.lastError, formatDateTime(channel.lastErrorAt, locale)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

private fun secretHint(channel: NotificationSettingsChannel?): Int =
    if (channel?.hasSecret == true) R.string.notification_settings_secret_stored else R.string.notification_settings_secret_new
