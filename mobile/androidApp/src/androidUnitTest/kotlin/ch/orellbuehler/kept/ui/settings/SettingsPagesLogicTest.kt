package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.model.MarketDataPage
import ch.orellbuehler.kept.model.MarketDataSettings
import ch.orellbuehler.kept.model.NotificationSettingsChannel
import ch.orellbuehler.kept.model.NotificationSettingsTest
import ch.orellbuehler.kept.model.NotificationSettingsTriggers
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SettingsPagesLogicTest {
    private val ntfy =
        NotificationSettingsChannel(
            kind = "ntfy",
            enabled = true,
            fields = mapOf("serverUrl" to "https://ntfy.example.org", "topic" to "kept-example"),
            hasSecret = true,
        )
    private val webhook = NotificationSettingsChannel(kind = "webhook", fields = mapOf("url" to "https://hooks.example.org/kept"))

    @Test
    fun theTriggerFormSendsTheFieldsOfTheWebForm() {
        val form = TriggerFormValues.of(NotificationSettingsTriggers(true, 5, true, true, 90, false, 21))
        assertEquals(
            listOf(
                "billDueEnabled" to "on",
                "billDueDays" to "5",
                "billOverdueEnabled" to "on",
                "budgetEnabled" to "on",
                "budgetPercent" to "90",
                "staleImportDays" to "21",
            ),
            form.fields(),
        )
        assertEquals(
            listOf("billDueDays" to "1", "budgetPercent" to "2", "staleImportDays" to "3"),
            TriggerFormValues(billDueDays = " 1", budgetPercent = "2 ", staleImportDays = "3").fields(),
        )
    }

    @Test
    fun theChannelFormKeepsSecretsOutOfTheStartValues() {
        val form = ChannelFormValues.of(ntfy)
        assertEquals("https://ntfy.example.org", form.serverUrl)
        assertEquals("kept-example", form.topic)
        assertEquals("", form.token)
        assertEquals("", ChannelFormValues.of(webhook.copy(fields = emptyMap())).url)
        assertEquals(ChannelFormValues(), ChannelFormValues.of(null))
    }

    @Test
    fun aBlankSecretIsSentBlankSoTheServerKeepsTheStoredOne() {
        val form = ChannelFormValues(serverUrl = " https://ntfy.example.org ", topic = "kept-example")
        assertEquals(
            listOf("kind" to "ntfy", "serverUrl" to "https://ntfy.example.org", "topic" to "kept-example", "token" to ""),
            form.fields("ntfy"),
        )
        assertEquals(
            listOf(
                "kind" to "ntfy",
                "serverUrl" to "https://ntfy.example.org",
                "topic" to "kept-example",
                "token" to "s3",
                "removeSecret" to "on",
            ),
            form.copy(token = "s3", removeSecret = true).fields("ntfy"),
        )
    }

    @Test
    fun eachKindSendsItsOwnFields() {
        assertEquals(
            listOf("kind" to "webhook", "url" to "https://hooks.example.org/kept", "secret" to ""),
            ChannelFormValues(url = "https://hooks.example.org/kept").fields("webhook"),
        )
        assertEquals(
            listOf("kind" to "email", "to" to "someone@example.org"),
            ChannelFormValues(to = " someone@example.org ").fields("email"),
        )
        assertEquals(
            listOf("kind" to "email", "to" to "someone@example.org"),
            ChannelFormValues(to = "someone@example.org", removeSecret = true).fields("email"),
        )
    }

    @Test
    fun aChannelNeedsItsRequiredFields() {
        assertFalse(ChannelFormValues(serverUrl = "https://ntfy.example.org").complete("ntfy"))
        assertTrue(ChannelFormValues(serverUrl = "https://ntfy.example.org", topic = "t").complete("ntfy"))
        assertFalse(ChannelFormValues().complete("webhook"))
        assertTrue(ChannelFormValues(url = "https://hooks.example.org").complete("webhook"))
        assertFalse(ChannelFormValues(to = " ").complete("email"))
    }

    @Test
    fun onlyOfferedOrExistingKindsAreShownInTheWebOrder() {
        assertEquals(listOf("ntfy", "webhook"), shownKinds(listOf("webhook", "ntfy"), emptyList()))
        assertEquals(listOf("ntfy", "email"), shownKinds(listOf("ntfy"), listOf(NotificationSettingsChannel("email"))))
        assertEquals(ntfy, channelOf("ntfy", listOf(webhook, ntfy)))
        assertEquals(null, channelOf("email", listOf(webhook, ntfy)))
    }

    @Test
    fun emailIsLockedForTheReasonTheServerGives() {
        assertEquals(ChannelLock.SMTP, channelLock("email", "smtp"))
        assertEquals(ChannelLock.ADMIN, channelLock("email", "admin"))
        assertEquals(ChannelLock.NONE, channelLock("email", null))
        assertEquals(ChannelLock.NONE, channelLock("ntfy", "smtp"))
        assertTrue(emailUnavailable(listOf("ntfy"), null, emptyList()))
        assertFalse(emailUnavailable(listOf("ntfy"), "smtp", emptyList()))
        assertFalse(emailUnavailable(listOf("ntfy", "email"), null, emptyList()))
        assertFalse(emailUnavailable(listOf("ntfy"), null, listOf(NotificationSettingsChannel("email"))))
    }

    @Test
    fun aChannelIsEnabledPausedOrInNeedOfReentry() {
        assertEquals(ChannelStatus.ENABLED, channelStatus(ntfy))
        assertEquals(ChannelStatus.PAUSED, channelStatus(webhook))
        assertEquals(ChannelStatus.NEEDS_REENTRY, channelStatus(ntfy.copy(needsReentry = true)))
    }

    @Test
    fun aTestMessageReportsSuccessOrTheReason() {
        assertEquals("sent", testMessage(NotificationSettingsTest(true), "sent", "failed"))
        assertEquals("http_500", testMessage(NotificationSettingsTest(false, "http_500"), "sent", "failed"))
        assertEquals("failed", testMessage(NotificationSettingsTest(false, null), "sent", "failed"))
        assertEquals("failed", testMessage(NotificationSettingsTest(false, " "), "sent", "failed"))
    }

    @Test
    fun thePasswordFormChecksBeforeAskingTheServer() {
        val empty = PasswordFormValues()
        assertFalse(empty.ready())
        assertFalse(empty.tooShort())
        assertFalse(empty.mismatch(touched = true))
        val short = PasswordFormValues("old-secret", "short", "short")
        assertTrue(short.tooShort())
        assertFalse(short.ready())
        val typed = PasswordFormValues("old-secret", "a-long-new-secret", "a-long-new-secret")
        assertTrue(typed.ready())
        assertFalse(typed.mismatch(true))
        assertTrue(typed.copy(confirm = "other").mismatch(true))
        assertFalse(typed.copy(confirm = "other").mismatch(false))
        assertFalse(typed.copy(confirm = "other").ready())
        assertFalse(typed.copy(current = "").ready())
    }

    @Test
    fun theConfirmationNeverLeavesThePhone() {
        assertEquals(
            listOf("currentPassword" to "old-secret", "newPassword" to "a-long-new-secret"),
            PasswordFormValues("old-secret", "a-long-new-secret", "a-long-new-secret").fields(),
        )
    }

    @Test
    fun marketDataIsSentLikeACheckbox() {
        assertEquals(listOf("enabled" to "on"), marketDataFields(true))
        assertEquals(emptyList(), marketDataFields(false))
    }

    @Test
    fun pricesCanBeRefreshedWhenEnabledAndAProviderExists() {
        assertTrue(canRefresh(MarketDataPage(MarketDataSettings(enabled = true), providerAvailable = true)))
        assertFalse(canRefresh(MarketDataPage(MarketDataSettings(enabled = false), providerAvailable = true)))
        assertFalse(canRefresh(MarketDataPage(MarketDataSettings(enabled = true), providerAvailable = false)))
    }
}
