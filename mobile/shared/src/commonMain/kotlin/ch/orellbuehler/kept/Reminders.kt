package ch.orellbuehler.kept

import kotlinx.coroutines.CancellationException
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atTime
import kotlinx.datetime.minus
import kotlinx.datetime.toInstant
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** What this device reminds about. Kept on the device: it is about its notifications, not the account. */
@Serializable
data class ReminderSettings(
    val enabled: Boolean = false,
    /** Remind this many days before a bill is due (and on the day itself). */
    val billDue: Boolean = true,
    val billDueDays: Int = 3,
    val billOverdue: Boolean = true,
    val budget: Boolean = false,
    val budgetPercent: Int = 100,
    val staleImport: Boolean = false,
    val staleImportDays: Int = 14,
    /** Local hour of the day at which scheduled reminders fire. */
    val hour: Int = 9,
)

@Serializable
internal data class ReminderEvent(
    val key: String,
    val kind: String = "",
    val title: String,
    val body: String,
)

@Serializable
data class ReminderBill(
    val id: String,
    val creditorName: String? = null,
    val invoiceNumber: String? = null,
    /** Minor units still to pay, or null when the bill has no amount. */
    val remaining: Long? = null,
    val currency: String = "",
    val dueDate: String,
)

@Serializable
internal data class ReminderSnapshot(
    val today: String = "",
    val events: List<ReminderEvent> = emptyList(),
    val bills: List<ReminderBill> = emptyList(),
)

/** A notification to show now. */
data class ReminderNotice(
    val key: String,
    /** "bill-overdue", "bill-due", "budget" or "stale-import". */
    val kind: String,
    val title: String,
    val body: String,
    /** The bill the notice is about, to open it on tap. */
    val billId: String?,
)

/** A notification to schedule for a bill's due date. The UI words it from [bill] and [daysBefore]. */
data class ScheduledReminder(
    /** Stable per bill, due date and lead time: scheduling it again replaces it. */
    val id: String,
    val bill: ReminderBill,
    /** 0 on the due date itself. */
    val daysBefore: Int,
    val fireAtEpochSeconds: Long,
)

data class ReminderPlan(
    /** Not shown on this device before. Call [Reminders.markShown] once they are posted. */
    val now: List<ReminderNotice>,
    /** Replaces everything scheduled earlier: cancel what is pending, then schedule these. */
    val scheduled: List<ScheduledReminder>,
)

class Reminders internal constructor(
    private val sdk: KeptSdk,
    private val prefs: KeyValueStore,
) {
    var settings: ReminderSettings
        get() =
            prefs.get(KEY_SETTINGS)?.let { runCatching { KeptJson.decodeFromString<ReminderSettings>(it) }.getOrNull() }
                ?: ReminderSettings()
        set(value) = prefs.set(KEY_SETTINGS, KeptJson.encodeToString(value))

    /**
     * Asks the server what is due and works out what to notify about. Returns an empty plan when
     * reminders are off or nobody is signed in. Run it when the app opens and from the periodic background job.
     */
    @Throws(KeptException::class, CancellationException::class)
    suspend fun plan(
        nowEpochSeconds: Long,
        timeZoneId: String,
    ): ReminderPlan {
        val current = settings
        if (!current.enabled || !sdk.signedIn) return ReminderPlan(emptyList(), emptyList())
        val query = LinkedHashMap<String, String>()
        if (current.billDue) query["billDueDays"] = current.billDueDays.toString()
        if (current.billOverdue) query["billOverdue"] = "true"
        if (current.budget) query["budgetPercent"] = current.budgetPercent.toString()
        if (current.staleImport) query["staleImportDays"] = current.staleImportDays.toString()
        val snapshot =
            try {
                KeptJson.decodeFromString<ReminderSnapshot>(sdk.get("reminders", query))
            } catch (e: KeptException) {
                throw e
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                throw KeptException(KeptErrorKind.SERVER, "The server answered something this app does not understand.")
            }
        return planFrom(snapshot, current, shownKeys(), nowEpochSeconds, timeZoneId)
    }

    /** Remembers that these notices were posted, so the next [plan] leaves them out. */
    fun markShown(keys: List<String>) {
        if (keys.isEmpty()) return
        val all = (shownKeys() + keys).toList().takeLast(MAX_SHOWN)
        prefs.set(KEY_SHOWN, KeptJson.encodeToString(all))
    }

    internal fun forget() {
        prefs.set(KEY_SHOWN, null)
        prefs.set(KEY_SETTINGS, null)
    }

    private fun shownKeys(): LinkedHashSet<String> =
        prefs
            .get(KEY_SHOWN)
            ?.let { runCatching { KeptJson.decodeFromString<List<String>>(it) }.getOrNull() }
            ?.let { LinkedHashSet(it) } ?: LinkedHashSet()

    private companion object {
        const val KEY_SETTINGS = "reminders.settings"
        const val KEY_SHOWN = "reminders.shown"
        const val MAX_SHOWN = 500
    }
}

/** iOS keeps at most 64 pending notifications per app; leave room for the ones shown right away. */
internal const val MAX_SCHEDULED = 40

internal fun planFrom(
    snapshot: ReminderSnapshot,
    settings: ReminderSettings,
    shown: Set<String>,
    nowEpochSeconds: Long,
    timeZoneId: String,
): ReminderPlan {
    val now =
        snapshot.events
            .filter { it.key !in shown }
            .map { event ->
                val parts = event.key.split(":")
                ReminderNotice(
                    key = event.key,
                    kind = event.kind.ifEmpty { parts.first() },
                    title = event.title,
                    body = event.body,
                    billId = parts.getOrNull(1)?.takeIf { parts.first().startsWith("bill") },
                )
            }
    if (!settings.billDue) return ReminderPlan(now, emptyList())

    val zone = runCatching { TimeZone.of(timeZoneId) }.getOrDefault(TimeZone.UTC)
    val time = LocalTime(settings.hour.coerceIn(0, 23), 0)
    val leads = if (settings.billDueDays > 0) listOf(settings.billDueDays, 0) else listOf(0)
    val scheduled =
        snapshot.bills
            .flatMap { bill ->
                val due = runCatching { LocalDate.parse(bill.dueDate) }.getOrNull() ?: return@flatMap emptyList()
                leads.map { days ->
                    ScheduledReminder(
                        id = "bill-due:${bill.id}:${bill.dueDate}:$days",
                        bill = bill,
                        daysBefore = days,
                        fireAtEpochSeconds =
                            due
                                .minus(days, DateTimeUnit.DAY)
                                .atTime(time)
                                .toInstant(zone)
                                .epochSeconds,
                    )
                }
            }.filter { it.fireAtEpochSeconds > nowEpochSeconds }
            .sortedWith(compareBy({ it.fireAtEpochSeconds }, { it.id }))
            .take(MAX_SCHEDULED)
    return ReminderPlan(now, scheduled)
}
