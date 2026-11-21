package ch.orellbuehler.kept.ui.accounts

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun AccountsScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
