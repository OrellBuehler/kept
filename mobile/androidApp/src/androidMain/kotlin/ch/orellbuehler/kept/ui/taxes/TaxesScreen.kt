package ch.orellbuehler.kept.ui.taxes

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun TaxesScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
