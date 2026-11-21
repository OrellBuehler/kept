package ch.orellbuehler.kept.ui.accounts

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun AccountImportsScreen(
    id: String,
    nav: Navigator,
) {
    ComingSoon(onBack = nav::back)
}
