package ch.orellbuehler.kept.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.KeptErrorKind
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.LoginStep
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AuthUiState(
    val busy: Boolean = false,
    val error: String? = null,
    /** The server answered but has no user yet. */
    val setupRequired: Boolean = false,
    /** Set while the second factor is asked for; true when an authenticator code works. */
    val codeTotp: Boolean? = null,
)

class AuthViewModel(
    private val sdk: KeptSdk,
) : ViewModel() {
    private val mutableState = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = mutableState.asStateFlow()

    fun connect(address: String) =
        run {
            val info = sdk.connect(address)
            if (info.setupRequired) mutableState.update { it.copy(setupRequired = true) }
        }

    fun login(
        username: String,
        password: String,
    ) = run {
        val step = sdk.login(username.trim(), password)
        if (step is LoginStep.CodeRequired) mutableState.update { it.copy(codeTotp = step.totp) }
    }

    fun verify(code: String) =
        run(onError = { e -> if (e.status == 410) mutableState.update { it.copy(codeTotp = null) } }) {
            sdk.verifyCode(code.trim())
        }

    fun cancelCode() {
        sdk.cancelSecondFactor()
        mutableState.value = AuthUiState()
    }

    fun changeServer() = sdk.disconnect()

    private fun run(
        onError: (KeptException) -> Unit = {},
        block: suspend () -> Unit,
    ) {
        if (mutableState.value.busy) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                block()
                mutableState.update { it.copy(busy = false) }
            } catch (e: KeptException) {
                val text =
                    if (e.kind == KeptErrorKind.RATE_LIMITED && e.retryAfterSeconds != null) {
                        "${e.message} (${e.retryAfterSeconds} s)"
                    } else {
                        e.message
                    }
                mutableState.update { it.copy(busy = false, error = text) }
                onError(e)
            }
        }
    }
}

@Composable
private fun AuthFrame(
    title: String,
    text: String,
    content: @Composable () -> Unit,
) {
    Scaffold { inner ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(inner)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                painterResource(R.drawable.ic_notification),
                contentDescription = null,
                modifier = Modifier.size(56.dp),
                tint = MaterialTheme.colorScheme.onBackground,
            )
            Text(title, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
        }
    }
}

@Composable
private fun SubmitButton(
    label: String,
    busy: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Button(onClick = onClick, enabled = enabled && !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        } else {
            Text(label, maxLines = 1)
        }
    }
}

@Composable
private fun ErrorText(text: String?) {
    if (!text.isNullOrBlank()) Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
}

/** First start: which server to talk to. */
@Composable
fun ServerScreen() {
    val vm = keptViewModel { AuthViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    var address by rememberSaveable { mutableStateOf("") }
    AuthFrame(stringResource(R.string.server_title), stringResource(R.string.server_text)) {
        FormTextField(
            label = stringResource(R.string.server_address),
            value = address,
            onValueChange = { address = it },
            placeholder = stringResource(R.string.server_address_placeholder),
            keyboardType = KeyboardType.Uri,
        )
        ErrorText(state.error)
        SubmitButton(stringResource(R.string.server_connect), state.busy, address.isNotBlank()) { vm.connect(address) }
    }
}

/** Username and password, then the second factor when the account has one. */
@Composable
fun LoginScreen(
    serverUrl: String,
    expired: Boolean,
) {
    val vm = keptViewModel { AuthViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    val host = serverUrl.substringAfter("://")

    val totp = state.codeTotp
    if (totp != null) {
        AuthFrame(
            stringResource(R.string.code_title),
            stringResource(if (totp) R.string.code_text else R.string.code_text_recovery),
        ) {
            FormTextField(
                label = stringResource(R.string.code_label),
                value = code,
                onValueChange = { code = it },
                keyboardType = if (totp) KeyboardType.Number else KeyboardType.Ascii,
            )
            ErrorText(state.error)
            SubmitButton(stringResource(R.string.code_submit), state.busy, code.isNotBlank()) { vm.verify(code) }
            TextButton(
                onClick = {
                    code = ""
                    vm.cancelCode()
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.code_cancel)) }
        }
        return
    }

    AuthFrame(stringResource(R.string.login_title), host) {
        if (serverUrl.startsWith("http://")) {
            Text(stringResource(R.string.server_insecure), color = MaterialTheme.kept.warning, style = MaterialTheme.typography.bodySmall)
        }
        if (state.setupRequired) {
            Text(stringResource(R.string.server_setup_required), style = MaterialTheme.typography.bodyMedium)
        }
        if (expired && state.error == null) {
            Text(stringResource(R.string.login_expired), style = MaterialTheme.typography.bodyMedium)
        }
        FormTextField(
            label = stringResource(R.string.login_username),
            value = username,
            onValueChange = { username = it },
            keyboardType = KeyboardType.Ascii,
        )
        FormTextField(
            label = stringResource(R.string.login_password),
            value = password,
            onValueChange = { password = it },
            password = true,
        )
        ErrorText(state.error)
        SubmitButton(stringResource(R.string.login_submit), state.busy, username.isNotBlank() && password.isNotEmpty()) {
            vm.login(username, password)
        }
        TextButton(onClick = vm::changeServer, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.login_change_server))
        }
    }
}
