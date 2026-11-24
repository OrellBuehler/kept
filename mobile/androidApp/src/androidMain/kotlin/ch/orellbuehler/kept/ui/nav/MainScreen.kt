package ch.orellbuehler.kept.ui.nav

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Savings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ui.AppViewModel
import ch.orellbuehler.kept.ui.accounts.AccountImportsScreen
import ch.orellbuehler.kept.ui.accounts.AccountScreen
import ch.orellbuehler.kept.ui.accounts.AccountsScreen
import ch.orellbuehler.kept.ui.bills.BillNewScreen
import ch.orellbuehler.kept.ui.bills.BillScreen
import ch.orellbuehler.kept.ui.bills.BillsScreen
import ch.orellbuehler.kept.ui.budgets.BudgetsScreen
import ch.orellbuehler.kept.ui.common.LocalSdk
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.dashboard.DashboardScreen
import ch.orellbuehler.kept.ui.forecast.ForecastScreen
import ch.orellbuehler.kept.ui.imports.ImportMappingScreen
import ch.orellbuehler.kept.ui.imports.ImportPendingScreen
import ch.orellbuehler.kept.ui.imports.ImportScreen
import ch.orellbuehler.kept.ui.investments.InvestmentsScreen
import ch.orellbuehler.kept.ui.more.MoreScreen
import ch.orellbuehler.kept.ui.pillar3a.Pillar3aScreen
import ch.orellbuehler.kept.ui.recurring.RecurringScreen
import ch.orellbuehler.kept.ui.reports.ReportsScreen
import ch.orellbuehler.kept.ui.review.ReviewScreen
import ch.orellbuehler.kept.ui.settings.AccountSettingsScreen
import ch.orellbuehler.kept.ui.settings.CategoriesScreen
import ch.orellbuehler.kept.ui.settings.MarketDataScreen
import ch.orellbuehler.kept.ui.settings.NotificationsScreen
import ch.orellbuehler.kept.ui.settings.PreferencesScreen
import ch.orellbuehler.kept.ui.settings.SettingsScreen
import ch.orellbuehler.kept.ui.taxes.TaxYearScreen
import ch.orellbuehler.kept.ui.taxes.TaxesScreen

private data class Tab(
    val route: String,
    val label: Int,
    val icon: ImageVector,
)

private val tabs =
    listOf(
        Tab(Routes.OVERVIEW, R.string.nav_overview, Icons.Outlined.Dashboard),
        Tab(Routes.ACCOUNTS, R.string.nav_accounts, Icons.Outlined.AccountBalance),
        Tab(Routes.BILLS, R.string.nav_bills, Icons.AutoMirrored.Outlined.ReceiptLong),
        Tab(Routes.BUDGETS, R.string.nav_budgets, Icons.Outlined.Savings),
        Tab(Routes.MORE, R.string.nav_more, Icons.Outlined.Menu),
    )

/** The signed-in app: five tabs, everything else is pushed on top of them. */
@Composable
fun MainScreen(app: AppViewModel) {
    val controller = rememberNavController()
    val context = LocalContext.current
    val serverUrl = LocalSdk.current.serverUrl.orEmpty()
    val nav = remember(controller, serverUrl) { Navigator(controller, context, serverUrl) }
    val entry by controller.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val overdue = LocalSession.current?.overdueBills ?: 0

    val pendingBill by app.pendingBill.collectAsStateWithLifecycle()
    LaunchedEffect(pendingBill) {
        pendingBill?.let {
            nav.open(Routes.bill(it))
            app.billOpened()
        }
    }

    Scaffold(
        bottomBar = {
            if (route in Routes.tabs) {
                NavigationBar {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = route == tab.route,
                            onClick = {
                                controller.navigate(tab.route) {
                                    popUpTo(controller.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = {
                                if (tab.route == Routes.BILLS && overdue > 0) {
                                    BadgedBox(badge = { Badge { Text(overdue.toString()) } }) { Icon(tab.icon, contentDescription = null) }
                                } else {
                                    Icon(tab.icon, contentDescription = null)
                                }
                            },
                            label = { Text(stringResource(tab.label), maxLines = 1) },
                        )
                    }
                }
            }
        },
    ) { inner ->
        // Screens bring their own top bar and handle the top inset; only the bottom bar's space is taken here.
        val bottom = PaddingValues(bottom = inner.calculateBottomPadding())
        Box(Modifier.padding(bottom).consumeWindowInsets(bottom)) {
            NavHost(navController = controller, startDestination = Routes.OVERVIEW) { destinations(nav, app) }
        }
    }
}

private fun NavGraphBuilder.destinations(
    nav: Navigator,
    app: AppViewModel,
) {
    fun arg(
        entry: androidx.navigation.NavBackStackEntry,
        name: String,
    ): String = entry.arguments?.getString(name).orEmpty()

    composable(Routes.OVERVIEW) { DashboardScreen(nav) }
    composable(Routes.ACCOUNTS) { AccountsScreen(nav) }
    composable(Routes.ACCOUNT) { AccountScreen(arg(it, "id"), nav) }
    composable(Routes.ACCOUNT_IMPORTS) { AccountImportsScreen(arg(it, "id"), nav) }
    composable(Routes.BILLS) { BillsScreen(nav) }
    composable(Routes.BILL_NEW) { BillNewScreen(nav) }
    composable(Routes.BILL) { BillScreen(arg(it, "id"), nav) }
    composable(Routes.BUDGETS) { BudgetsScreen(nav) }
    composable(Routes.MORE) { MoreScreen(nav) }
    composable(Routes.FORECAST) { ForecastScreen(nav) }
    composable(Routes.RECURRING) { RecurringScreen(nav) }
    composable(Routes.REVIEW) { ReviewScreen(nav) }
    composable(Routes.REPORTS) { ReportsScreen(nav) }
    composable(Routes.INVESTMENTS) { InvestmentsScreen(nav) }
    composable(Routes.PILLAR_3A) { Pillar3aScreen(nav) }
    composable(Routes.TAXES) { TaxesScreen(nav) }
    composable(Routes.TAX_YEAR) { TaxYearScreen(arg(it, "year"), nav) }
    composable(Routes.IMPORT) { ImportScreen(nav) }
    composable(Routes.IMPORT_PENDING) { ImportPendingScreen(arg(it, "pendingId"), nav) }
    composable(Routes.IMPORT_MAPPING) { ImportMappingScreen(arg(it, "pendingId"), nav) }
    composable(Routes.SETTINGS) { SettingsScreen(nav, app) }
    composable(Routes.SETTINGS_CATEGORIES) { CategoriesScreen(nav) }
    composable(Routes.SETTINGS_PREFERENCES) { PreferencesScreen(nav) }
    composable(Routes.SETTINGS_NOTIFICATIONS) { NotificationsScreen(nav) }
    composable(Routes.SETTINGS_ACCOUNT) { AccountSettingsScreen(nav) }
    composable(Routes.SETTINGS_MARKET_DATA) { MarketDataScreen(nav) }
}
