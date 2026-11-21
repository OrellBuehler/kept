package ch.orellbuehler.kept.ui.investments

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun InvestmentsScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
