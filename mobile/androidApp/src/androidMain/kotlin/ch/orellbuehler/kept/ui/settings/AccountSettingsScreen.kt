package ch.orellbuehler.kept.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountSettingsPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.KeyValueRow
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator

class AccountSettingsViewModel(
    sdk: KeptSdk,
) : PageViewModel<AccountSettingsPage>(sdk, { it.load("settings/account") }) {
    /** Changes the password; [changedMessage] is shown once the server took it. */
    fun changePassword(
        values: PasswordFormValues,
        changedMessage: String,
    ) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        submit("settings/account", "changePassword", form, reload = false) { message(changedMessage) }
    }
}

/** Who is signed in, and a form to change the password. */
@Composable
fun AccountSettingsScreen(nav: Navigator) {
    val vm = keptViewModel { AccountSettingsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var touched by remember { mutableStateOf(false) }
    val changed = stringResource(R.string.account_settings_changed)
    PageScaffold(
        title = stringResource(R.string.account_settings_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event ->
            if (event is UiEvent.Saved) {
                current = ""
                new = ""
                confirm = ""
                touched = false
            }
        },
    ) { page, padding ->
        val values = PasswordFormValues(current, new, confirm)
        ScrollColumn(padding) {
            SectionCard(title = stringResource(R.string.account_settings_profile)) {
                KeyValueRow(stringResource(R.string.account_settings_username), page.user.username)
                KeyValueRow(
                    stringResource(R.string.account_settings_display_name),
                    page.user.displayName?.takeIf { it.isNotBlank() } ?: stringResource(R.string.account_settings_not_set),
                )
                KeyValueRow(
                    stringResource(R.string.account_settings_role),
                    stringResource(if (page.user.role == "admin") R.string.account_settings_admin else R.string.account_settings_member),
                )
            }
            SectionCard(
                title = stringResource(R.string.account_settings_password),
                subtitle = stringResource(R.string.account_settings_password_text),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    FormTextField(
                        label = stringResource(R.string.account_settings_current),
                        value = current,
                        onValueChange = { current = it.take(PASSWORD_MAX) },
                        error = errors["currentPassword"],
                        password = true,
                        enabled = !busy,
                    )
                    FormTextField(
                        label = stringResource(R.string.account_settings_new),
                        value = new,
                        onValueChange = { new = it.take(PASSWORD_MAX) },
                        error =
                            errors["newPassword"]
                                ?: if (values.tooShort()) stringResource(R.string.account_settings_too_short, PASSWORD_MIN) else null,
                        hint = stringResource(R.string.account_settings_new_hint, PASSWORD_MIN),
                        password = true,
                        enabled = !busy,
                    )
                    FormTextField(
                        label = stringResource(R.string.account_settings_confirm),
                        value = confirm,
                        onValueChange = {
                            confirm = it.take(PASSWORD_MAX)
                            touched = true
                        },
                        error = if (values.mismatch(touched)) stringResource(R.string.account_settings_mismatch) else null,
                        password = true,
                        enabled = !busy,
                    )
                    errors["form"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Button(
                        onClick = { vm.changePassword(values, changed) },
                        enabled = !busy && values.ready(),
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        } else {
                            Text(stringResource(R.string.account_settings_change))
                        }
                    }
                }
            }
        }
    }
}
