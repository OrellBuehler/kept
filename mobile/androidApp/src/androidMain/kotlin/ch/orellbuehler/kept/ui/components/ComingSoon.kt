package ch.orellbuehler.kept.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Construction
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ui.common.Load

/** Placeholder of a screen that is not built yet. */
@Composable
fun ComingSoon(onBack: () -> Unit) {
    PageScaffold(title = stringResource(R.string.app_name), state = Load.Ready(Unit), onRefresh = {}, onBack = onBack) { _, _ ->
        MessagePane(icon = Icons.Outlined.Construction, title = stringResource(R.string.coming_soon))
    }
}
