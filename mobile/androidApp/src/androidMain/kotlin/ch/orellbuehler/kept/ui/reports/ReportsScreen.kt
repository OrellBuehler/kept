package ch.orellbuehler.kept.ui.reports

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun ReportsScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
