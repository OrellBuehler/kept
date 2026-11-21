package ch.orellbuehler.kept.ui.budgets

import androidx.compose.runtime.Composable
import ch.orellbuehler.kept.ui.components.ComingSoon
import ch.orellbuehler.kept.ui.nav.Navigator

@Composable
fun BudgetsScreen(nav: Navigator) {
    ComingSoon(onBack = nav::back)
}
