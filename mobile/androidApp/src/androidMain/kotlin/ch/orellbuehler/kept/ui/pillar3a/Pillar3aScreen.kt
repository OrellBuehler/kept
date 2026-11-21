package ch.orellbuehler.kept.ui.pillar3a

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun Pillar3aScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
