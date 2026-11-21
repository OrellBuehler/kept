package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.model.NotificationSettingsChannel
import ch.orellbuehler.kept.model.NotificationSettingsTest
import ch.orellbuehler.kept.model.NotificationSettingsTriggers

/** The kinds of channel, in the order the web lists them. */
val CHANNEL_KINDS = listOf("ntfy", "webhook", "email")

/** The channels to show: the ones the server offers and the ones that already exist. */
fun shownKinds(
    offered: List<String>,
    channels: List<NotificationSettingsChannel>,
): List<String> = CHANNEL_KINDS.filter { kind -> kind in offered || channels.any { it.kind == kind } }

/** The channel of [kind], if the user has set one up. */
fun channelOf(
    kind: String,
    channels: List<NotificationSettingsChannel>,
): NotificationSettingsChannel? = channels.firstOrNull { it.kind == kind }

/** Why a kind cannot be set up, as the page says it: only email can be blocked. */
enum class ChannelLock { NONE, SMTP, ADMIN }

fun channelLock(
    kind: String,
    emailBlocked: String?,
): ChannelLock =
    when {
        kind != "email" -> ChannelLock.NONE
        emailBlocked == "smtp" -> ChannelLock.SMTP
        emailBlocked == "admin" -> ChannelLock.ADMIN
        else -> ChannelLock.NONE
    }

/** True when email is not offered and the user has no email channel: the page then tells why. */
fun emailUnavailable(
    kinds: List<String>,
    emailBlocked: String?,
    channels: List<NotificationSettingsChannel>,
): Boolean = "email" !in kinds && emailBlocked == null && channels.none { it.kind == "email" }

enum class ChannelStatus { NEEDS_REENTRY, ENABLED, PAUSED }

fun channelStatus(channel: NotificationSettingsChannel): ChannelStatus =
    when {
        channel.needsReentry -> ChannelStatus.NEEDS_REENTRY
        channel.enabled -> ChannelStatus.ENABLED
        else -> ChannelStatus.PAUSED
    }

/** What the trigger form holds; the numbers are text while they are typed. */
data class TriggerFormValues(
    val billDueEnabled: Boolean = false,
    val billDueDays: String = "3",
    val billOverdueEnabled: Boolean = false,
    val budgetEnabled: Boolean = false,
    val budgetPercent: String = "100",
    val staleImportEnabled: Boolean = false,
    val staleImportDays: String = "14",
) {
    /** The fields of `saveSettings`; a switch that is off is left out, like an unticked checkbox. */
    fun fields(): List<Pair<String, String>> =
        buildList {
            if (billDueEnabled) add("billDueEnabled" to "on")
            add("billDueDays" to billDueDays.trim())
            if (billOverdueEnabled) add("billOverdueEnabled" to "on")
            if (budgetEnabled) add("budgetEnabled" to "on")
            add("budgetPercent" to budgetPercent.trim())
            if (staleImportEnabled) add("staleImportEnabled" to "on")
            add("staleImportDays" to staleImportDays.trim())
        }

    companion object {
        fun of(settings: NotificationSettingsTriggers): TriggerFormValues =
            TriggerFormValues(
                billDueEnabled = settings.billDueEnabled,
                billDueDays = settings.billDueDays.toString(),
                billOverdueEnabled = settings.billOverdueEnabled,
                budgetEnabled = settings.budgetEnabled,
                budgetPercent = settings.budgetPercent.toString(),
                staleImportEnabled = settings.staleImportEnabled,
                staleImportDays = settings.staleImportDays.toString(),
            )
    }
}

/**
 * What a channel form holds. The secret ([token] of ntfy, [secret] of a webhook) is never prefilled: the server does not
 * send it, and a blank one keeps the stored one.
 */
data class ChannelFormValues(
    val serverUrl: String = "",
    val topic: String = "",
    val token: String = "",
    val url: String = "",
    val secret: String = "",
    val to: String = "",
    val removeSecret: Boolean = false,
) {
    /** True when the fields the kind requires are filled in. */
    fun complete(kind: String): Boolean =
        when (kind) {
            "ntfy" -> serverUrl.isNotBlank() && topic.isNotBlank()
            "webhook" -> url.isNotBlank()
            else -> to.isNotBlank()
        }

    /** The fields of `saveChannel` for [kind]. */
    fun fields(kind: String): List<Pair<String, String>> =
        buildList {
            add("kind" to kind)
            when (kind) {
                "ntfy" -> {
                    add("serverUrl" to serverUrl.trim())
                    add("topic" to topic.trim())
                    add("token" to token)
                    if (removeSecret) add("removeSecret" to "on")
                }
                "webhook" -> {
                    add("url" to url.trim())
                    add("secret" to secret)
                    if (removeSecret) add("removeSecret" to "on")
                }
                else -> add("to" to to.trim())
            }
        }

    companion object {
        fun of(channel: NotificationSettingsChannel?): ChannelFormValues =
            ChannelFormValues(
                serverUrl = channel?.fields?.get("serverUrl").orEmpty(),
                topic = channel?.fields?.get("topic").orEmpty(),
                url = channel?.fields?.get("url").orEmpty(),
                to = channel?.fields?.get("to").orEmpty(),
            )
    }
}

/** What to tell the user after a test message: [sent] on success, else the server's reason, else [failed]. */
fun testMessage(
    result: NotificationSettingsTest,
    sent: String,
    failed: String,
): String = if (result.ok) sent else result.reason?.takeIf { it.isNotBlank() } ?: failed
