package ch.orellbuehler.kept.ui

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.SessionInfo
import ch.orellbuehler.kept.SessionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** App-wide state: who is signed in ([KeptSdk.state]), their session details, and where a notification wants to go. */
class AppViewModel(
    private val sdk: KeptSdk,
) : ViewModel() {
    val state: StateFlow<SessionState> = sdk.state

    private val mutableSession = MutableStateFlow<SessionInfo?>(null)
    val session: StateFlow<SessionInfo?> = mutableSession.asStateFlow()

    private val mutablePendingBill = MutableStateFlow<String?>(null)

    /** A bill to open as soon as the main screen is up (from a reminder). */
    val pendingBill: StateFlow<String?> = mutablePendingBill.asStateFlow()

    private val mutableBrowserReturn = MutableStateFlow<String?>(null)

    /** The address the browser handed a sign-in back with, until the login screen has taken it. */
    val browserReturn: StateFlow<String?> = mutableBrowserReturn.asStateFlow()

    init {
        viewModelScope.launch {
            sdk.state.collect { state ->
                if (state is SessionState.SignedIn) refreshSession() else mutableSession.value = null
            }
        }
    }

    /** Fetches user, preferences and the overdue count again; a failure keeps what is there. */
    fun refreshSession() {
        if (sdk.state.value !is SessionState.SignedIn) return
        viewModelScope.launch {
            try {
                mutableSession.value = sdk.session()
            } catch (e: KeptException) {
                // Offline or signed out meanwhile: the screens say so themselves.
            }
        }
    }

    fun openBill(id: String) {
        mutablePendingBill.value = id
    }

    fun browserReturned(address: String) {
        mutableBrowserReturn.value = address
    }

    fun browserReturnTaken() {
        mutableBrowserReturn.value = null
    }

    fun billOpened() {
        mutablePendingBill.value = null
    }

    private val mutablePendingPath = MutableStateFlow<String?>(null)

    /** A web path to open as soon as the main screen is up (store screenshots, debug builds). */
    val pendingPath: StateFlow<String?> = mutablePendingPath.asStateFlow()

    fun pathOpened() {
        mutablePendingPath.value = null
    }

    /**
     * Store screenshots (mobile/scripts/screenshots), debug builds only: signs in to [server] unless
     * the app already is signed in, then opens [path].
     */
    fun screenshotLaunch(
        server: String,
        username: String,
        password: String,
        path: String?,
    ) {
        viewModelScope.launch {
            try {
                if (sdk.state.value !is SessionState.SignedIn) {
                    sdk.connect(server)
                    sdk.login(username, password)
                }
                mutablePendingPath.value = path
            } catch (e: KeptException) {
                Log.w("Screenshots", "sign-in failed: ${e.kind}")
            }
        }
    }

    fun logout() {
        viewModelScope.launch { sdk.logout() }
    }
}
