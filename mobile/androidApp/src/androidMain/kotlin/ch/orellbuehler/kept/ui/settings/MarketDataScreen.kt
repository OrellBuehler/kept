package ch.orellbuehler.kept.ui.settings

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun MarketDataScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
