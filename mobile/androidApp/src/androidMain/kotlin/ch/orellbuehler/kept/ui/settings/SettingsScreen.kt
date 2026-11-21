package ch.orellbuehler.kept.ui.settings

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.BuildConfig
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ReminderSettings
import ch.orellbuehler.kept.reminders.ReminderScheduler
import ch.orellbuehler.kept.ui.AppViewModel
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalSdk
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept

/** The app's own settings (reminders, server, sign-out) and the way into Kept's settings pages. */
@Composable
fun SettingsScreen(
    nav: Navigator,
    app: AppViewModel,
) {
    val sdk = LocalSdk.current
    val session = LocalSession.current
    val context = LocalContext.current
    var confirmDisconnect by remember { mutableStateOf(false) }

    PageScaffold(
        title = stringResource(R.string.settings_title),
        state = Load.Ready(Unit),
        onRefresh = {},
        onBack = nav::back,
    ) { _, padding ->
        ScrollColumn(padding) {
            SectionCard(
                title = session?.user?.label ?: stringResource(R.string.app_name),
                subtitle = sdk.serverUrl?.substringAfter("://"),
            ) {
                if (sdk.insecure) {
                    Text(
                        stringResource(R.string.server_insecure),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.kept.warning,
                    )
                }
            }

            RemindersCard()

            SectionCard(title = stringResource(R.string.settings_kept), contentPadding = false) {
                val pages =
                    listOf(
                        Routes.SETTINGS_CATEGORIES to R.string.settings_categories,
                        Routes.SETTINGS_PREFERENCES to R.string.settings_preferences,
                        Routes.SETTINGS_NOTIFICATIONS to R.string.settings_notifications,
                        Routes.SETTINGS_MARKET_DATA to R.string.settings_market_data,
                        Routes.SETTINGS_ACCOUNT to R.string.settings_account,
                    )
                pages.forEachIndexed { index, (route, label) ->
                    if (index > 0) RowDivider()
                    ListRow(title = stringResource(label), onClick = { nav.open(route) }, showChevron = true)
                }
            }

            SectionCard(title = stringResource(R.string.settings_browser), contentPadding = false) {
                val pages =
                    buildList {
                        add("settings/security" to R.string.settings_security)
                        add("settings/api-tokens" to R.string.settings_api_tokens)
                        add("settings/paperless" to R.string.settings_paperless)
                        if (session?.user?.isAdmin == true) {
                            add("admin/users" to R.string.settings_admin_users)
                            add("admin/backup" to R.string.settings_admin_backup)
                        }
                    }
                pages.forEachIndexed { index, (path, label) ->
                    if (index > 0) RowDivider()
                    ListRow(title = stringResource(label), onClick = { nav.openInBrowser(path) }) {
                        Icon(
                            Icons.AutoMirrored.Outlined.OpenInNew,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            SectionCard(contentPadding = false) {
                ListRow(
                    title = stringResource(R.string.settings_sign_out),
                    subtitle = stringResource(R.string.settings_sign_out_text),
                    leading = { Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null) },
                    onClick = {
                        ReminderScheduler.apply(context, false)
                        app.logout()
                    },
                )
                RowDivider()
                ListRow(
                    title = stringResource(R.string.settings_forget_server),
                    leading = { Icon(Icons.Outlined.LinkOff, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = { confirmDisconnect = true },
                )
            }

            Text(
                stringResource(R.string.settings_app_version, BuildConfig.VERSION_NAME),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }

    if (confirmDisconnect) {
        ConfirmDialog(
            title = stringResource(R.string.settings_forget_server),
            text = stringResource(R.string.settings_forget_server_text),
            confirmLabel = stringResource(R.string.settings_forget_server_confirm),
            onConfirm = {
                ReminderScheduler.apply(context, false)
                sdk.disconnect()
            },
            onDismiss = { confirmDisconnect = false },
        )
    }
}

@Composable
private fun RemindersCard() {
    val sdk = LocalSdk.current
    val context = LocalContext.current
    var settings by remember { mutableStateOf(sdk.reminders.settings) }
    var allowed by remember { mutableStateOf(ReminderScheduler.canNotify(context)) }

    fun update(next: ReminderSettings) {
        settings = next
        sdk.reminders.settings = next
        ReminderScheduler.apply(context, next.enabled)
        ReminderScheduler.syncNow(context)
    }

    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            allowed = granted
            update(settings.copy(enabled = true))
        }

    SectionCard(title = stringResource(R.string.reminders_title)) {
        SwitchRow(
            title = stringResource(R.string.reminders_enable),
            subtitle = stringResource(R.string.reminders_enable_text),
            checked = settings.enabled,
            onCheckedChange = { on ->
                if (on && Build.VERSION.SDK_INT >= 33 && !ReminderScheduler.canNotify(context)) {
                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    allowed = ReminderScheduler.canNotify(context)
                    update(settings.copy(enabled = on))
                }
            },
        )
        if (!settings.enabled) return@SectionCard
        if (!allowed) {
            Text(stringResource(R.string.reminders_denied), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.kept.warning)
            TextButton(
                onClick = {
                    context.startActivity(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                },
            ) { Text(stringResource(R.string.reminders_open_settings)) }
        }
        Column {
            SwitchRow(stringResource(R.string.reminders_bill_due), settings.billDue, { update(settings.copy(billDue = it)) })
            if (settings.billDue) {
                NumberChoice(R.string.reminders_bill_due_days, listOf(0, 1, 2, 3, 5, 7, 14), settings.billDueDays) {
                    update(settings.copy(billDueDays = it))
                }
                ChoiceField(
                    label = stringResource(R.string.reminders_hour),
                    options = (6..21).map { Choice(it.toString(), "%02d:00".format(it)) },
                    selected = settings.hour.toString(),
                    onSelect = { update(settings.copy(hour = it.toInt())) },
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            SwitchRow(stringResource(R.string.reminders_bill_overdue), settings.billOverdue, { update(settings.copy(billOverdue = it)) })
            SwitchRow(stringResource(R.string.reminders_budget), settings.budget, { update(settings.copy(budget = it)) })
            if (settings.budget) {
                NumberChoice(R.string.reminders_budget_percent, listOf(50, 75, 90, 100), settings.budgetPercent) {
                    update(settings.copy(budgetPercent = it))
                }
            }
            SwitchRow(stringResource(R.string.reminders_stale_import), settings.staleImport, { update(settings.copy(staleImport = it)) })
            if (settings.staleImport) {
                NumberChoice(R.string.reminders_stale_days, listOf(7, 14, 30, 60), settings.staleImportDays) {
                    update(settings.copy(staleImportDays = it))
                }
            }
        }
    }
}

@Composable
private fun NumberChoice(
    label: Int,
    values: List<Int>,
    selected: Int,
    onSelect: (Int) -> Unit,
) {
    ChoiceField(
        label = stringResource(label),
        options = (values + selected).distinct().sorted().map { Choice(it.toString(), it.toString()) },
        selected = selected.toString(),
        onSelect = { onSelect(it.toInt()) },
    )
}
