package ch.orellbuehler.kept.ui.bills

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun BillsScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
