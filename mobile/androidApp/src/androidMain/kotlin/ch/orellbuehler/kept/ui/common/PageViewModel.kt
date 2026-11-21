package ch.orellbuehler.kept.ui.common

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.ActionResponse
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptErrorKind
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.data.PageRedirect
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What a screen shows for the data it loads. */
sealed interface Load<out T> {
    data object Loading : Load<Nothing>

    data class Failed(
        val message: String,
        /** True when the server could not be reached: the screen offers "try again" rather than "go back". */
        val offline: Boolean,
    ) : Load<Nothing>

    data class Ready<T>(
        val value: T,
        val refreshing: Boolean = false,
    ) : Load<T>
}

/** One-off things a screen reacts to once: a snackbar, or a navigation after a form was saved. */
sealed interface UiEvent {
    data class Message(
        val text: String,
    ) : UiEvent

    /** The web path the page navigates to after an action or load, e.g. "/bills/abc". */
    data class Navigate(
        val webPath: String,
    ) : UiEvent

    /** A form was saved: close the sheet or dialog that sent it. */
    data object Saved : UiEvent
}

/**
 * Base of every screen's view model: loads one page, keeps the last data while refreshing, and
 * runs the page's form actions.
 *
 * A subclass passes how to fetch its data and calls [submit] for each action. Field errors of a
 * refused form are in [formErrors] ("form" holds the ones that belong to no field).
 */
open class PageViewModel<T>(
    protected val sdk: KeptSdk,
    private val fetch: suspend (KeptSdk) -> T,
) : ViewModel() {
    private val mutableState = MutableStateFlow<Load<T>>(Load.Loading)
    val state: StateFlow<Load<T>> = mutableState.asStateFlow()

    private val mutableBusy = MutableStateFlow(false)

    /** True while an action runs: disable the buttons that would start another. */
    val busy: StateFlow<Boolean> = mutableBusy.asStateFlow()

    private val mutableFormErrors = MutableStateFlow<Map<String, String>>(emptyMap())
    val formErrors: StateFlow<Map<String, String>> = mutableFormErrors.asStateFlow()

    private val eventChannel = Channel<UiEvent>(Channel.BUFFERED)
    val events: Flow<UiEvent> = eventChannel.receiveAsFlow()

    private var loadJob: Job? = null

    init {
        refresh()
    }

    /** Loads again; data already on screen stays visible meanwhile. */
    fun refresh() {
        loadJob?.cancel()
        loadJob =
            viewModelScope.launch {
                mutableState.update { if (it is Load.Ready) it.copy(refreshing = true) else Load.Loading }
                try {
                    mutableState.value = Load.Ready(fetch(sdk))
                } catch (e: PageRedirect) {
                    eventChannel.trySend(UiEvent.Navigate(e.location))
                } catch (e: KeptException) {
                    val current = mutableState.value
                    if (current is Load.Ready) {
                        // Keep what is on screen and say that it could not be refreshed.
                        mutableState.value = current.copy(refreshing = false)
                        eventChannel.trySend(UiEvent.Message(e.message.orEmpty()))
                    } else {
                        mutableState.value = Load.Failed(e.message.orEmpty(), e.kind == KeptErrorKind.NETWORK)
                    }
                }
            }
    }

    fun clearFormErrors() {
        mutableFormErrors.value = emptyMap()
    }

    protected fun message(text: String) {
        eventChannel.trySend(UiEvent.Message(text))
    }

    /**
     * Runs a form action of [path]. On success the page is reloaded, [UiEvent.Saved] is sent (plus
     * [UiEvent.Navigate] when the web would navigate) and [onSuccess] runs. A refused form fills
     * [formErrors]; when [showRefusal] is set the first error is also shown as a message, for
     * actions that have no form on screen (delete, toggle).
     */
    protected fun submit(
        path: String,
        action: String,
        form: FormBody = FormBody(),
        query: Map<String, String> = emptyMap(),
        showRefusal: Boolean = false,
        reload: Boolean = true,
        onSuccess: (ActionResponse) -> Unit = {},
    ) {
        if (mutableBusy.value) return
        mutableBusy.value = true
        mutableFormErrors.value = emptyMap()
        viewModelScope.launch {
            try {
                val result = sdk.action(path, action, form, query)
                if (result.ok) {
                    eventChannel.trySend(UiEvent.Saved)
                    result.redirect?.let { eventChannel.trySend(UiEvent.Navigate(it)) }
                    onSuccess(result)
                    if (reload) refresh()
                } else {
                    mutableFormErrors.value = result.fieldErrors
                    if (showRefusal || result.fieldErrors.isEmpty()) {
                        eventChannel.trySend(UiEvent.Message(result.message.orEmpty()))
                    }
                }
            } catch (e: KeptException) {
                eventChannel.trySend(UiEvent.Message(e.message.orEmpty()))
            } finally {
                mutableBusy.value = false
            }
        }
    }
}
