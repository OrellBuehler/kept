package ch.orellbuehler.kept.ui.imports

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun ImportPendingScreen(
    pendingId: String,
    nav: Navigator,
) {
    ComingSoon(onBack = nav::back)
}
