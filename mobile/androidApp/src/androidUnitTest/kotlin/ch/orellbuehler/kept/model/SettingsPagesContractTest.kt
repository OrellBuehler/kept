package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SettingsPagesContractTest {
    @Test
    fun decodesTheCategories() {
        val page = Contract.page<CategoriesPage>("settings.categories")
        assertEquals(12, page.categories.size)
        assertTrue(page.categories.all { it.id.isNotEmpty() && it.name.isNotEmpty() && it.kind in listOf("expense", "income") })
        val groceries = page.categories.first { it.name == "Groceries" }
        val food = page.categories.first { it.name == "Food" }
        assertEquals(food.id, groceries.parentId)
        assertEquals("#ef6c00", groceries.color)
        assertEquals("shopping-cart", groceries.icon)
        assertEquals(9, groceries.transactionCount)
        assertNull(food.parentId)
        assertNull(page.categories.first { it.name == "Restaurants" }.color)
        assertNull(page.categories.first { it.name == "Subscriptions" }.icon)
        assertEquals("income", page.categories.first { it.name == "Salary" }.kind)
    }

    @Test
    fun decodesTheRules() {
        val page = Contract.page<CategoriesPage>("settings.categories")
        assertEquals(7, page.rules.size)
        assertTrue(page.rules.all { rule -> page.categories.any { it.id == rule.categoryId } })
        val first = page.rules.first()
        assertEquals(10, first.priority)
        assertEquals("Grocer", first.counterpartyContains)
        assertEquals("expense", first.amountSign)
        assertEquals("Groceries", first.categoryName)
        assertNull(first.descriptionContains)
        assertNotNull(page.rules.first { it.counterpartyIban != null }.descriptionContains)
        assertNull(page.rules.first { it.counterpartyContains == "Bistro" }.amountSign)
        assertEquals(500, page.rules.last().priority)
    }

    @Test
    fun decodesWhatApplyRulesAnswers() {
        val result = decodePage<CategoriesApplyResult>("""{"success":true,"action":"applyRules","categorized":3,"scanned":8}""")
        assertEquals(3, result.categorized)
        assertEquals(8, result.scanned)
    }

    @Test
    fun decodesThePreferences() {
        val preferences = Contract.page<PreferencesPage>("settings.preferences").preferences
        assertEquals("masked", preferences.ibanDisplay)
        assertTrue(preferences.blurAmounts)
        assertEquals("de-CH", preferences.locale)
        assertEquals("CHF", preferences.defaultCurrency)
        assertEquals(25, preferences.pageSize)
        assertTrue(preferences.investmentCashLiquid)
    }

    @Test
    fun decodesTheNotificationSettings() {
        val page = Contract.page<NotificationSettingsPage>("settings.notifications")
        assertTrue(page.settings.billDueEnabled)
        assertEquals(5, page.settings.billDueDays)
        assertTrue(page.settings.billOverdueEnabled)
        assertTrue(page.settings.budgetEnabled)
        assertEquals(90, page.settings.budgetPercent)
        assertFalse(page.settings.staleImportEnabled)
        assertEquals(21, page.settings.staleImportDays)
        assertEquals("smtp", page.emailBlocked)
        assertEquals(listOf("ntfy", "webhook"), page.kinds)
    }

    @Test
    fun decodesTheChannelsWithoutTheirSecrets() {
        val page = Contract.page<NotificationSettingsPage>("settings.notifications")
        assertEquals(listOf("ntfy", "webhook"), page.channels.map { it.kind })
        val ntfy = page.channels.first()
        assertTrue(ntfy.enabled)
        assertEquals("https://ntfy.example.org", ntfy.fields["serverUrl"])
        assertEquals("kept-example", ntfy.fields["topic"])
        assertNull(ntfy.fields["token"])
        assertTrue(ntfy.hasSecret)
        assertFalse(ntfy.needsReentry)
        assertNotNull(ntfy.lastSuccessAt)
        assertNull(ntfy.lastError)
        val webhook = page.channels.last()
        assertEquals("https://hooks.example.org/kept", webhook.fields["url"])
        assertNull(webhook.lastSuccessAt)
        assertEquals("http_500", webhook.lastError)
        assertNotNull(webhook.lastErrorAt)
    }

    @Test
    fun decodesWhatTestChannelAnswers() {
        val ok = decodePage<NotificationSettingsTestAnswer>("""{"action":"test","kind":"ntfy","result":{"ok":true}}""")
        assertTrue(ok.result.ok)
        val failed =
            decodePage<NotificationSettingsTestAnswer>("""{"action":"test","kind":"ntfy","result":{"ok":false,"reason":"http_500"}}""")
        assertFalse(failed.result.ok)
        assertEquals("http_500", failed.result.reason)
    }

    @Test
    fun anAdministratorCanAddEmailWhenTheServerHasAMailServer() {
        val page =
            decodePage<NotificationSettingsPage>(
                """
                {"settings":{"billDueEnabled":false,"billDueDays":3,"billOverdueEnabled":false,"budgetEnabled":false,"budgetPercent":100,
                 "staleImportEnabled":false,"staleImportDays":14},
                 "channels":[{"kind":"email","enabled":false,"fields":{"to":"someone@example.org"},"hasSecret":false,"needsReentry":true,
                              "lastSuccessAt":null,"lastError":null,"lastErrorAt":null}],
                 "emailBlocked":null,"kinds":["ntfy","webhook","email"]}
                """.trimIndent(),
            )
        assertNull(page.emailBlocked)
        assertTrue(page.channels.single().needsReentry)
        assertEquals("someone@example.org", page.channels.single().fields["to"])
        assertEquals(3, page.kinds.size)
    }

    @Test
    fun decodesTheAccountSettings() {
        val user = Contract.page<AccountSettingsPage>("settings.account").user
        assertTrue(user.id.isNotEmpty())
        assertEquals("alice", user.username)
        assertEquals("Alice Example", user.displayName)
        assertEquals("admin", user.role)
    }

    @Test
    fun aMemberMayHaveNoDisplayName() {
        val user = decodePage<AccountSettingsPage>("""{"user":{"id":"u","username":"bob","displayName":null,"role":"member"}}""").user
        assertNull(user.displayName)
        assertEquals("member", user.role)
    }

    @Test
    fun decodesTheMarketDataSettings() {
        val page = Contract.page<MarketDataPage>("settings.market-data")
        assertFalse(page.settings.enabled)
        assertNull(page.settings.lastRunAt)
        assertNull(page.settings.lastError)
        assertFalse(page.providerAvailable)
    }

    @Test
    fun decodesAMarketDataRun() {
        val page =
            decodePage<MarketDataPage>(
                """{"settings":{"enabled":true,"lastRunAt":1700000000000,"lastError":"boom"},"providerAvailable":true}""",
            )
        assertTrue(page.settings.enabled)
        assertEquals(1700000000000, page.settings.lastRunAt)
        assertEquals("boom", page.settings.lastError)
        val answer =
            decodePage<MarketDataRefreshAnswer>(
                """{"success":true,"action":"refresh","result":{"securities":2,"fxPairs":1,"prices":40,"fxRates":20,"errors":["x"]}}""",
            )
        assertEquals(2, answer.result.securities)
        assertEquals(1, answer.result.fxPairs)
        assertEquals(40, answer.result.prices)
        assertEquals(20, answer.result.fxRates)
        assertEquals(listOf("x"), answer.result.errors)
    }
}
