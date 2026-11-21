package ch.orellbuehler.kept.ui.nav

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.navigation.NavHostController

/**
 * Routes are the web paths without the leading slash ("bills/abc", "accounts/x/imports"), so a
 * redirect the server answers with can be followed as it is.
 */
object Routes {
    const val OVERVIEW = "overview"
    const val ACCOUNTS = "accounts"
    const val ACCOUNT = "accounts/{id}"
    const val ACCOUNT_IMPORTS = "accounts/{id}/imports"
    const val BILLS = "bills"
    const val BILL_NEW = "bills/new"
    const val BILL = "bills/{id}"
    const val BUDGETS = "budgets"
    const val MORE = "more"
    const val FORECAST = "forecast"
    const val RECURRING = "recurring"
    const val REVIEW = "review"
    const val REPORTS = "reports"
    const val INVESTMENTS = "investments"
    const val PILLAR_3A = "pillar-3a"
    const val TAXES = "taxes"
    const val TAX_YEAR = "taxes/{year}"
    const val IMPORT = "import"
    const val IMPORT_PENDING = "import/{pendingId}"
    const val IMPORT_MAPPING = "import/{pendingId}/mapping"
    const val SETTINGS = "settings"
    const val SETTINGS_CATEGORIES = "settings/categories"
    const val SETTINGS_PREFERENCES = "settings/preferences"
    const val SETTINGS_NOTIFICATIONS = "settings/notifications"
    const val SETTINGS_ACCOUNT = "settings/account"
    const val SETTINGS_MARKET_DATA = "settings/market-data"

    val tabs = listOf(OVERVIEW, ACCOUNTS, BILLS, BUDGETS, MORE)

    fun account(id: String) = "accounts/$id"

    fun accountImports(id: String) = "accounts/$id/imports"

    fun bill(id: String) = "bills/$id"

    fun taxYear(year: Int) = "taxes/$year"

    fun importPending(id: String) = "import/$id"

    fun importMapping(id: String) = "import/$id/mapping"

    /** Web pages the app has no screen for; they open in the browser. */
    val webOnly = listOf("settings/security", "settings/api-tokens", "settings/paperless", "admin/users", "admin/backup")

    /**
     * The route for a web path such as "/bills/abc?x=1" or "/", or null when the app has no
     * screen for it.
     */
    fun fromWebPath(webPath: String): String? {
        val path = webPath.substringBefore('?').substringBefore('#').trim('/')
        if (path.isEmpty()) return OVERVIEW
        if (webOnly.any { path == it || path.startsWith("$it/") }) return null
        val known =
            listOf(
                ACCOUNTS,
                ACCOUNT,
                ACCOUNT_IMPORTS,
                BILLS,
                BILL_NEW,
                BILL,
                BUDGETS,
                FORECAST,
                RECURRING,
                REVIEW,
                REPORTS,
                INVESTMENTS,
                PILLAR_3A,
                TAXES,
                TAX_YEAR,
                IMPORT,
                IMPORT_PENDING,
                IMPORT_MAPPING,
                SETTINGS_CATEGORIES,
                SETTINGS_PREFERENCES,
                SETTINGS_NOTIFICATIONS,
                SETTINGS_ACCOUNT,
                SETTINGS_MARKET_DATA,
            )
        val segments = path.split('/')
        val matches =
            known.any { pattern ->
                val parts = pattern.split('/')
                parts.size == segments.size && parts.indices.all { parts[it].startsWith("{") || parts[it] == segments[it] }
            }
        return if (matches) path else null
    }
}

/** What a screen may do to move around. Screens get it as a parameter and never see the NavController. */
class Navigator(
    private val controller: NavHostController,
    private val context: Context,
    private val serverUrl: String,
) {
    fun back() {
        controller.popBackStack()
    }

    fun open(route: String) {
        controller.navigate(route) { launchSingleTop = true }
    }

    /** Replaces the current screen: after a form created something, or a page redirected. */
    fun replace(route: String) {
        val current = controller.currentDestination?.route
        controller.navigate(route) {
            launchSingleTop = true
            if (current != null) popUpTo(current) { inclusive = true }
        }
    }

    /** Follows a web path from a redirect; opens the browser when the app has no screen for it. */
    fun openWebPath(
        webPath: String,
        replace: Boolean = false,
    ) {
        val route = Routes.fromWebPath(webPath)
        when {
            route == null -> openInBrowser(webPath)
            replace -> replace(route)
            else -> open(route)
        }
    }

    /** Opens a page of the Kept server in the browser, for what the app does not do itself. */
    fun openInBrowser(webPath: String) {
        val url = serverUrl.trimEnd('/') + "/" + webPath.trimStart('/')
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
