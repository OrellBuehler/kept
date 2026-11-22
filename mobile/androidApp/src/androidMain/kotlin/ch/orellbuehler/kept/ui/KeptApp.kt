package ch.orellbuehler.kept.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.SessionState
import ch.orellbuehler.kept.ui.auth.LoginScreen
import ch.orellbuehler.kept.ui.auth.ServerScreen
import ch.orellbuehler.kept.ui.common.Formats
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalRefreshSession
import ch.orellbuehler.kept.ui.common.LocalSdk
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.nav.MainScreen
import ch.orellbuehler.kept.ui.theme.KeptTheme

@Composable
fun KeptApp(
    sdk: KeptSdk,
    app: AppViewModel,
) {
    val state by app.state.collectAsStateWithLifecycle()
    val session by app.session.collectAsStateWithLifecycle()
    val browserReturn by app.browserReturn.collectAsStateWithLifecycle()
    val locale = session?.preferences?.locale ?: "en-GB"
    val formats = remember(locale) { Formats(locale) }
    KeptTheme {
        CompositionLocalProvider(
            LocalSdk provides sdk,
            LocalSession provides session,
            LocalFormats provides formats,
            LocalRefreshSession provides app::refreshSession,
        ) {
            when (val current = state) {
                SessionState.NoServer -> ServerScreen()
                is SessionState.SignedOut ->
                    LoginScreen(
                        serverUrl = current.serverUrl,
                        expired = current.expired,
                        browserReturn = browserReturn,
                        onBrowserReturnTaken = app::browserReturnTaken,
                    )
                is SessionState.SignedIn -> MainScreen(app)
            }
        }
    }
}
