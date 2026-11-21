package ch.orellbuehler.kept.model

import ch.orellbuehler.kept.Preferences
import kotlinx.serialization.Serializable

/** `GET pages/settings/categories`: the categories (parents before their children, as the server lists them) and the rules. */
@Serializable
data class CategoriesPage(
    val categories: List<CategoriesCategory> = emptyList(),
    val rules: List<CategoriesRule> = emptyList(),
)

/** [kind] is "expense" or "income"; [parentId] is set for a subcategory; [color] is `#rrggbb`; [icon] one of the web's icon names. */
@Serializable
data class CategoriesCategory(
    val id: String,
    val name: String = "",
    val parentId: String? = null,
    val kind: String = "expense",
    val color: String? = null,
    val icon: String? = null,
    val transactionCount: Int = 0,
)

/** A rule gives a transaction a category when every condition that is set matches; [amountSign] is "income", "expense" or null. */
@Serializable
data class CategoriesRule(
    val id: String,
    val categoryId: String = "",
    val categoryName: String = "",
    val priority: Int = 100,
    val counterpartyContains: String? = null,
    val descriptionContains: String? = null,
    val counterpartyIban: String? = null,
    val amountSign: String? = null,
)

/** The answer of the `applyRules` action. */
@Serializable
data class CategoriesApplyResult(
    val categorized: Int = 0,
    val scanned: Int = 0,
)

/** `GET pages/settings/preferences`. */
@Serializable
data class PreferencesPage(
    val preferences: Preferences = Preferences(),
)

/** `GET pages/settings/notifications`: the triggers, the channels that exist and which kinds can be added. */
@Serializable
data class NotificationSettingsPage(
    val settings: NotificationSettingsTriggers = NotificationSettingsTriggers(),
    val channels: List<NotificationSettingsChannel> = emptyList(),
    /** Why email is not offered: "smtp" (the server has no mail server) or "admin" (only administrators); null when it is. */
    val emailBlocked: String? = null,
    val kinds: List<String> = emptyList(),
)

@Serializable
data class NotificationSettingsTriggers(
    val billDueEnabled: Boolean = false,
    val billDueDays: Int = 3,
    val billOverdueEnabled: Boolean = false,
    val budgetEnabled: Boolean = false,
    val budgetPercent: Int = 100,
    val staleImportEnabled: Boolean = false,
    val staleImportDays: Int = 14,
)

/** A channel of the user: [kind] is "ntfy", "webhook" or "email". Secrets are never sent: [hasSecret] only says there is one. */
@Serializable
data class NotificationSettingsChannel(
    val kind: String,
    val enabled: Boolean = false,
    val fields: Map<String, String> = emptyMap(),
    val hasSecret: Boolean = false,
    val needsReentry: Boolean = false,
    val lastSuccessAt: Long? = null,
    val lastError: String? = null,
    val lastErrorAt: Long? = null,
)

/** The answer of the `testChannel` action: [ok], or [reason] for what went wrong. */
@Serializable
data class NotificationSettingsTest(
    val ok: Boolean = false,
    val reason: String? = null,
)

@Serializable
data class NotificationSettingsTestAnswer(
    val result: NotificationSettingsTest = NotificationSettingsTest(),
)

/** `GET pages/settings/account`. */
@Serializable
data class AccountSettingsPage(
    val user: AccountSettingsUser,
)

@Serializable
data class AccountSettingsUser(
    val id: String = "",
    val username: String = "",
    val displayName: String? = null,
    val role: String = "member",
)

/** `GET pages/settings/market-data`. */
@Serializable
data class MarketDataPage(
    val settings: MarketDataSettings = MarketDataSettings(),
    val providerAvailable: Boolean = false,
)

@Serializable
data class MarketDataSettings(
    val enabled: Boolean = false,
    val lastRunAt: Long? = null,
    val lastError: String? = null,
)

/** What a price refresh did, as the `refresh` action answers. */
@Serializable
data class MarketDataRefresh(
    val securities: Int = 0,
    val fxPairs: Int = 0,
    val prices: Int = 0,
    val fxRates: Int = 0,
    val errors: List<String> = emptyList(),
)

@Serializable
data class MarketDataRefreshAnswer(
    val result: MarketDataRefresh = MarketDataRefresh(),
)
