package ch.orellbuehler.kept.ui.reports

import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.model.ReportsPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.PageViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

class ReportsViewModel(
    sdk: KeptSdk,
) : PageViewModel<ReportsPage>(sdk, { it.load("reports") }) {
    private val mutableWorking = MutableStateFlow<ReportKind?>(null)

    /** The report that is being generated and downloaded, null when idle. */
    val working: StateFlow<ReportKind?> = mutableWorking.asStateFlow()

    private val files = Channel<File>(Channel.BUFFERED)

    /** A downloaded PDF that is ready to be opened, once each. */
    val downloaded: Flow<File> = files.receiveAsFlow()

    /**
     * Downloads a report into [directory] and announces the file on [downloaded]. A failure is shown
     * as a message that starts with [failedPrefix].
     */
    fun download(
        kind: ReportKind,
        query: Map<String, String>,
        directory: File,
        failedPrefix: String,
    ) {
        if (mutableWorking.value != null) return
        mutableWorking.value = kind
        viewModelScope.launch {
            try {
                val pdf = sdk.download("reports/${kind.path}", query)
                val file = File(directory, safeFileName(pdf.fileName, "kept-${kind.path}.pdf"))
                withContext(Dispatchers.IO) {
                    directory.mkdirs()
                    file.writeBytes(pdf.bytes)
                }
                files.trySend(file)
            } catch (e: KeptException) {
                message("$failedPrefix ${e.message.orEmpty()}".trim())
            } catch (e: IOException) {
                message("$failedPrefix ${e.message.orEmpty()}".trim())
            } finally {
                mutableWorking.value = null
            }
        }
    }

    fun notify(text: String) = message(text)
}
