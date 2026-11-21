package ch.orellbuehler.kept.ui.reports

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/** The sub directory of the cache directory the FileProvider shares (`res/xml/file_paths.xml`). */
const val DOCUMENTS_DIR = "documents"

/** Offers [file] in a chooser of the apps that can show a PDF. Returns false when the system found nothing to start. */
fun openPdf(
    context: Context,
    file: File,
    title: String,
): Boolean {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val view =
        Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/pdf")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return start(context, view, uri, file, title)
}

/** Opens the share sheet for [file]. Returns false when the system found nothing to start. */
fun sharePdf(
    context: Context,
    file: File,
    title: String,
): Boolean {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val send =
        Intent(Intent.ACTION_SEND)
            .setType("application/pdf")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return start(context, send, uri, file, title)
}

private fun start(
    context: Context,
    intent: Intent,
    uri: android.net.Uri,
    file: File,
    title: String,
): Boolean {
    val chooser = Intent.createChooser(intent, title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    chooser.clipData = ClipData.newRawUri(file.name, uri)
    return try {
        context.startActivity(chooser)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}
