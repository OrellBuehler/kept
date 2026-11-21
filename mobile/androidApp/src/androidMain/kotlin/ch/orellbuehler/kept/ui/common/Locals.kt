package ch.orellbuehler.kept.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.SessionInfo

val LocalSdk = staticCompositionLocalOf<KeptSdk> { error("No KeptSdk provided") }

/** Who is signed in, their preferences and the server's "today". Null until the first answer arrived. */
val LocalSession = staticCompositionLocalOf<SessionInfo?> { null }

val LocalFormats = staticCompositionLocalOf { Formats("en-GB") }

/** A view model that needs the SDK: `val vm = keptViewModel { BillsViewModel(it) }`. Pass [key] when the screen has an id. */
@Composable
inline fun <reified VM : ViewModel> keptViewModel(
    key: String? = null,
    crossinline create: (KeptSdk) -> VM,
): VM {
    val sdk = LocalSdk.current
    return viewModel(
        key = key,
        factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = create(sdk) as T
            },
    )
}
