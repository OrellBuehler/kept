package ch.orellbuehler.kept

import android.app.Application
import ch.orellbuehler.kept.reminders.ReminderScheduler
import ch.orellbuehler.kept.store.KeystoreStore
import ch.orellbuehler.kept.store.PrefsStore

class KeptApplication : Application() {
    val sdk: KeptSdk by lazy {
        KeptSdk(
            secure = KeystoreStore(this),
            prefs = PrefsStore(this),
            userAgent = "Kept-Android/${BuildConfig.VERSION_NAME}",
        )
    }

    override fun onCreate() {
        super.onCreate()
        ReminderScheduler.ensureChannel(this)
        ReminderScheduler.apply(this, sdk.reminders.settings.enabled)
    }
}
