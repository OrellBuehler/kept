package ch.orellbuehler.kept.ui.review

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun ReviewScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
