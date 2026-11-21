package ch.orellbuehler.kept.ui.imports

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/** A file the user picked: [size] is -1 when the provider did not say. */
data class PickedFile(
    val uri: String,
    val name: String,
    val size: Long,
)

/** What reading a picked file came to. */
sealed interface ImportFileRead {
    /** [base64] is the content, ready for the `file` field of the upload. */
    data class Ready(
        val name: String,
        val type: String,
        val base64: String,
    ) : ImportFileRead

    data object TooLarge : ImportFileRead

    data object Unreadable : ImportFileRead
}

private const val DEFAULT_NAME = "statement"

/** The name and size the provider knows for [uri]; null when it cannot be read at all. */
suspend fun describeFile(
    context: Context,
    uri: Uri,
): PickedFile? =
    withContext(Dispatchers.IO) {
        try {
            var name = DEFAULT_NAME
            var size = -1L
            context.contentResolver
                .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        if (!cursor.isNull(0)) name = cursor.getString(0)
                        if (!cursor.isNull(1)) size = cursor.getLong(1)
                    }
                }
            PickedFile(uri.toString(), name, size)
        } catch (e: SecurityException) {
            null
        }
    }

/**
 * Reads the bytes of [file] and encodes them for the upload, off the main thread. Files over [MAX_IMPORT_BYTES] are
 * refused without being read in full.
 */
suspend fun readImportFile(
    context: Context,
    file: PickedFile,
): ImportFileRead =
    withContext(Dispatchers.IO) {
        if (file.size > MAX_IMPORT_BYTES) return@withContext ImportFileRead.TooLarge
        val uri = Uri.parse(file.uri)
        val bytes =
            try {
                context.contentResolver.openInputStream(uri)?.use {
                    readLimited(it, MAX_IMPORT_BYTES)
                        ?: return@withContext ImportFileRead.TooLarge
                }
            } catch (e: IOException) {
                null
            } catch (e: SecurityException) {
                null
            } ?: return@withContext ImportFileRead.Unreadable
        if (bytes.isEmpty()) return@withContext ImportFileRead.Unreadable
        val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
        ImportFileRead.Ready(file.name, type, Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

/** All bytes of [input], or null as soon as there are more than [limit]. */
internal fun readLimited(
    input: InputStream,
    limit: Long,
): ByteArray? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        total += n
        if (total > limit) return null
        out.write(buffer, 0, n)
    }
    return out.toByteArray()
}
