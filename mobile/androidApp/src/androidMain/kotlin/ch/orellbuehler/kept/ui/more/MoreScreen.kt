package ch.orellbuehler.kept.ui.more

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ShowChart
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material.icons.outlined.Balance
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.FileUpload
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.components.IconBadge
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes

private data class Entry(
    val route: String,
    val label: Int,
    val icon: ImageVector,
)

private val planning =
    listOf(
        Entry(Routes.FORECAST, R.string.more_forecast, Icons.AutoMirrored.Outlined.TrendingUp),
        Entry(Routes.RECURRING, R.string.more_recurring, Icons.Outlined.Repeat),
        Entry(Routes.REVIEW, R.string.more_review, Icons.Outlined.DateRange),
        Entry(Routes.REPORTS, R.string.more_reports, Icons.Outlined.Description),
    )

private val wealth =
    listOf(
        Entry(Routes.INVESTMENTS, R.string.more_investments, Icons.AutoMirrored.Outlined.ShowChart),
        Entry(Routes.PILLAR_3A, R.string.more_pillar3a, Icons.Outlined.Lock),
        Entry(Routes.TAXES, R.string.more_taxes, Icons.Outlined.Balance),
    )

private val manage =
    listOf(
        Entry(Routes.IMPORT, R.string.more_import, Icons.Outlined.FileUpload),
        Entry(Routes.SETTINGS, R.string.more_settings, Icons.Outlined.Settings),
    )

/** Everything that has no tab of its own. */
@Composable
fun MoreScreen(nav: Navigator) {
    PageScaffold(title = stringResource(R.string.nav_more), state = Load.Ready(Unit), onRefresh = {}) { _, padding ->
        ScrollColumn(padding) {
            listOf(planning, wealth, manage).forEach { group ->
                SectionCard(contentPadding = false) {
                    group.forEachIndexed { index, entry ->
                        if (index > 0) RowDivider()
                        ListRow(
                            title = stringResource(entry.label),
                            leading = { IconBadge(entry.icon) },
                            onClick = { nav.open(entry.route) },
                            showChevron = true,
                        )
                    }
                }
            }
        }
    }
}
