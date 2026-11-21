package ch.orellbuehler.kept.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import ch.orellbuehler.kept.KeptApplication
import ch.orellbuehler.kept.KeptErrorKind
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.MainActivity
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ScheduledReminder
import ch.orellbuehler.kept.ui.common.Formats
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Reminders without a push service: a periodic job asks the server what is due, shows what is
 * new, and schedules one delayed job per upcoming due date so those fire even when the server
 * cannot be reached at that moment.
 */
object ReminderScheduler {
    const val EXTRA_BILL_ID = "kept.billId"
    private const val CHANNEL = "reminders"
    private const val PERIODIC = "kept-reminders"
    private const val NOW = "kept-reminders-now"
    private const val SCHEDULED_TAG = "kept-reminder-scheduled"
    private const val SYNC_HOURS = 6L

    fun ensureChannel(context: Context) {
        val channel =
            NotificationChannel(CHANNEL, context.getString(R.string.reminders_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = context.getString(R.string.reminders_channel_text)
            }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun canNotify(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (
                Build.VERSION.SDK_INT < 33 ||
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            )

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Starts or stops the background check to match the setting. */
    fun apply(
        context: Context,
        enabled: Boolean,
    ) {
        val work = WorkManager.getInstance(context)
        if (enabled) {
            work.enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<ReminderSyncWorker>(SYNC_HOURS, TimeUnit.HOURS).setConstraints(online).build(),
            )
        } else {
            work.cancelUniqueWork(PERIODIC)
            work.cancelUniqueWork(NOW)
            work.cancelAllWorkByTag(SCHEDULED_TAG)
        }
    }

    /** Checks once, soon: when the app comes to the front or the settings changed. */
    fun syncNow(context: Context) {
        val sdk = (context.applicationContext as KeptApplication).sdk
        if (!sdk.reminders.settings.enabled) return
        WorkManager.getInstance(context).enqueueUniqueWork(
            NOW,
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<ReminderSyncWorker>().setConstraints(online).build(),
        )
    }

    internal fun schedule(
        context: Context,
        reminders: List<ScheduledReminder>,
        nowEpochSeconds: Long,
    ) {
        val work = WorkManager.getInstance(context)
        work.cancelAllWorkByTag(SCHEDULED_TAG)
        val formats = Formats(Locale.getDefault().toLanguageTag())
        reminders.forEach { reminder ->
            val bill = reminder.bill
            val who = bill.creditorName ?: bill.invoiceNumber ?: context.getString(R.string.reminder_bill_fallback)
            val label = bill.remaining?.let { "$who (${formats.money(it, bill.currency)})" } ?: who
            val today = reminder.daysBefore == 0
            work.enqueue(
                OneTimeWorkRequestBuilder<ReminderNotifyWorker>()
                    .setInitialDelay((reminder.fireAtEpochSeconds - nowEpochSeconds).coerceAtLeast(0), TimeUnit.SECONDS)
                    .addTag(SCHEDULED_TAG)
                    .setInputData(
                        workDataOf(
                            KEY_ID to reminder.id,
                            KEY_TITLE to
                                context.getString(if (today) R.string.reminder_due_today_title else R.string.reminder_due_soon_title),
                            KEY_BODY to
                                if (today) {
                                    context.getString(R.string.reminder_due_today_body, label)
                                } else {
                                    context.getString(R.string.reminder_due_in_body, label, formats.date(bill.dueDate))
                                },
                            KEY_BILL to bill.id,
                        ),
                    ).build(),
            )
        }
    }

    internal fun post(
        context: Context,
        id: String,
        title: String,
        body: String,
        billId: String?,
    ) {
        if (!canNotify(context)) return
        val intent =
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (billId != null) putExtra(EXTRA_BILL_ID, billId)
            }
        val pending =
            PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification =
            NotificationCompat
                .Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(context, R.color.notification))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build()
        try {
            NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
        } catch (e: SecurityException) {
            // The permission was withdrawn between the check and the call: nothing to show.
        }
    }

    internal const val KEY_ID = "id"
    internal const val KEY_TITLE = "title"
    internal const val KEY_BODY = "body"
    internal const val KEY_BILL = "bill"
}

/** Asks the server what is due, shows what was not shown before and schedules the due-date reminders. */
class ReminderSyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val sdk = (applicationContext as KeptApplication).sdk
        val now = System.currentTimeMillis() / 1000
        val plan =
            try {
                sdk.reminders.plan(now, TimeZone.getDefault().id)
            } catch (e: KeptException) {
                return if (e.kind == KeptErrorKind.NETWORK || e.kind == KeptErrorKind.SERVER) Result.retry() else Result.success()
            }
        if (ReminderScheduler.canNotify(applicationContext)) {
            plan.now.forEach { ReminderScheduler.post(applicationContext, it.key, it.title, it.body, it.billId) }
            sdk.reminders.markShown(plan.now.map { it.key })
        }
        ReminderScheduler.schedule(applicationContext, plan.scheduled, now)
        return Result.success()
    }
}

/** Shows one scheduled reminder when its time has come. */
class ReminderNotifyWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val id = inputData.getString(ReminderScheduler.KEY_ID) ?: return Result.success()
        ReminderScheduler.post(
            applicationContext,
            id,
            inputData.getString(ReminderScheduler.KEY_TITLE).orEmpty(),
            inputData.getString(ReminderScheduler.KEY_BODY).orEmpty(),
            inputData.getString(ReminderScheduler.KEY_BILL),
        )
        return Result.success()
    }
}
