package ch.orellbuehler.kept

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import ch.orellbuehler.kept.reminders.ReminderScheduler
import ch.orellbuehler.kept.ui.AppViewModel
import ch.orellbuehler.kept.ui.KeptApp

class MainActivity : ComponentActivity() {
    private val sdk get() = (application as KeptApplication).sdk

    private val appViewModel: AppViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = AppViewModel(sdk) as T
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { KeptApp(sdk, appViewModel) }
        if (savedInstanceState == null) handleIncoming(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncoming(intent)
    }

    override fun onResume() {
        super.onResume()
        appViewModel.refreshSession()
        ReminderScheduler.syncNow(this)
    }

    /** A tap on a reminder opens the bill it is about; the browser comes back from a sign-in. */
    private fun handleIncoming(intent: Intent?) {
        intent?.getStringExtra(ReminderScheduler.EXTRA_BILL_ID)?.let(appViewModel::openBill)
        intent?.data?.takeIf { it.scheme == KeptSdk.BROWSER_CALLBACK_SCHEME }?.let { appViewModel.browserReturned(it.toString()) }
    }
}
