package ch.orellbuehler.kept.ui.recurring

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun RecurringScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
