package ch.orellbuehler.kept.ui.forecast

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun ForecastScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
