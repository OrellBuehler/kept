package ch.orellbuehler.kept.ui.bills

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.pdf.PdfDocument
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import ch.orellbuehler.kept.KeptSdk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/** The server refuses larger documents (`MAX_DOCUMENT_BYTES` of `src/lib/server/bills/documents.ts`). */
const val MAX_DOCUMENT_BYTES = 20L * 1024 * 1024

/** A photo or an image file is read up to this size; it is turned into a (smaller) PDF before it is sent. */
const val MAX_IMAGE_BYTES = 64L * 1024 * 1024

private const val PDF_PAGE_WIDTH = 595
private val imageSides = listOf(2400, 1800, 1200)
private const val DOCUMENTS_DIR = "documents"
private const val OPENED_PREFIX = "bill-"

/** What reading a document the user picked or photographed came to. */
sealed interface UploadPrep {
    /** [base64] is the PDF to send, [fileName] its name. */
    data class Ready(
        val fileName: String,
        val base64: String,
    ) : UploadPrep

    data object TooLarge : UploadPrep

    /** Neither a PDF nor an image the phone can decode. */
    data object NotSupported : UploadPrep

    data object Unreadable : UploadPrep
}

/** The width and height in points of a PDF page that shows an image of this shape across A4's width. */
fun pdfPageSize(
    width: Int,
    height: Int,
): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return PDF_PAGE_WIDTH to PDF_PAGE_WIDTH
    return PDF_PAGE_WIDTH to maxOf(1, Math.round(PDF_PAGE_WIDTH.toDouble() * height / width).toInt())
}

/** The power of two that brings the longer side of an image down to [maxSide] or just above it. */
fun imageSampleSize(
    width: Int,
    height: Int,
    maxSide: Int,
): Int {
    var sample = 1
    var longest = maxOf(width, height)
    while (longest / 2 >= maxSide) {
        sample *= 2
        longest /= 2
    }
    return sample
}

/** Degrees to rotate a photo by for its EXIF orientation value. */
fun exifRotation(orientation: Int): Int =
    when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
    }

/** A file name that is safe in the cache directory; [extension] replaces the original one when given. */
fun safeFileName(
    name: String,
    extension: String? = null,
): String {
    val base = name.substringAfterLast('/').let { if (extension != null) it.substringBeforeLast('.') else it }
    val cleaned =
        base
            .map { if (it.isLetterOrDigit() || it == '.' || it == '-' || it == '_') it else '_' }
            .joinToString("")
            .trim('.', '_')
            .take(60)
            .ifEmpty { "document" }
    return if (extension != null) "$cleaned.$extension" else cleaned
}

private fun isPdf(bytes: ByteArray): Boolean =
    bytes.size >= 5 &&
        bytes[0] == '%'.code.toByte() &&
        bytes[1] == 'P'.code.toByte() &&
        bytes[2] == 'D'.code.toByte() &&
        bytes[3] == 'F'.code.toByte()

private fun readLimited(
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

private fun imageToPdf(
    bytes: ByteArray,
    maxSide: Int,
): ByteArray? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply { inSampleSize = imageSampleSize(bounds.outWidth, bounds.outHeight, maxSide) }
    var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
    val orientation =
        ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    val rotation = exifRotation(orientation)
    if (rotation != 0) {
        val rotated =
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
        if (rotated !== bitmap) bitmap.recycle()
        bitmap = rotated
    }
    val (width, height) = pdfPageSize(bitmap.width, bitmap.height)
    val document = PdfDocument()
    try {
        val page = document.startPage(PdfDocument.PageInfo.Builder(width, height, 1).create())
        page.canvas.drawBitmap(bitmap, null, Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG))
        document.finishPage(page)
        val out = ByteArrayOutputStream()
        document.writeTo(out)
        return out.toByteArray()
    } finally {
        document.close()
        bitmap.recycle()
    }
}

/**
 * Reads a picked or photographed document off the main thread and turns it into what the server
 * takes: a PDF of at most [MAX_DOCUMENT_BYTES]. A photo or image file becomes a one-page PDF.
 */
suspend fun prepareUpload(
    context: Context,
    uri: Uri,
): UploadPrep =
    withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var name = "document"
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(0)?.let { name = it }
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
        } catch (e: SecurityException) {
            return@withContext UploadPrep.Unreadable
        }
        val isImage = resolver.getType(uri)?.startsWith("image/") == true
        val limit = if (isImage) MAX_IMAGE_BYTES else MAX_DOCUMENT_BYTES
        if (size > limit) return@withContext UploadPrep.TooLarge
        val bytes =
            try {
                resolver.openInputStream(uri)?.use { readLimited(it, limit) ?: return@withContext UploadPrep.TooLarge }
            } catch (e: java.io.IOException) {
                null
            } ?: return@withContext UploadPrep.Unreadable
        if (isPdf(bytes)) {
            return@withContext if (bytes.size > MAX_DOCUMENT_BYTES) {
                UploadPrep.TooLarge
            } else {
                UploadPrep.Ready(safeFileName(name), Base64.encodeToString(bytes, Base64.NO_WRAP))
            }
        }
        for (side in imageSides) {
            val pdf = imageToPdf(bytes, side) ?: return@withContext UploadPrep.NotSupported
            if (pdf.size <= MAX_DOCUMENT_BYTES) {
                return@withContext UploadPrep.Ready(safeFileName(name, "pdf"), Base64.encodeToString(pdf, Base64.NO_WRAP))
            }
        }
        UploadPrep.TooLarge
    }

/** The two ways to hand the app a document; [reading] is true while a chosen file is being read. */
class DocumentSource(
    val pickFile: () -> Unit,
    val takePhoto: () -> Unit,
    val reading: Boolean,
)

/** The system file picker and the system camera, with the result already prepared for upload. */
@Composable
fun rememberDocumentSource(onResult: (UploadPrep) -> Unit): DocumentSource {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reading by remember { mutableStateOf(false) }
    var photoPath by rememberSaveable { mutableStateOf<String?>(null) }

    fun handle(
        uri: Uri,
        afterwards: () -> Unit = {},
    ) {
        reading = true
        scope.launch {
            try {
                onResult(prepareUpload(context, uri))
            } finally {
                reading = false
                afterwards()
            }
        }
    }

    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) handle(uri)
        }
    val camera =
        rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
            val file = photoPath?.let(::File)
            photoPath = null
            if (file == null) return@rememberLauncherForActivityResult
            if (taken && file.length() > 0) {
                handle(FileProvider.getUriForFile(context, "${context.packageName}.files", file)) { file.delete() }
            } else {
                file.delete()
            }
        }
    return DocumentSource(
        pickFile = { picker.launch(arrayOf("application/pdf", "image/*")) },
        takePhoto = {
            val dir = File(context.cacheDir, DOCUMENTS_DIR).apply { mkdirs() }
            val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
            photoPath = file.absolutePath
            camera.launch(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
        },
        reading = reading,
    )
}

/** How opening a stored document ended. */
enum class OpenResult { Opened, NoApp }

/**
 * Downloads the document of a bill into the cache directory and hands it to whatever app opens
 * its type. Throws `KeptException` when the download fails.
 */
suspend fun openBillDocument(
    context: Context,
    sdk: KeptSdk,
    billId: String,
    fileName: String,
): OpenResult {
    val download = sdk.download("bills/$billId/document")
    val file =
        withContext(Dispatchers.IO) {
            val dir = File(context.cacheDir, DOCUMENTS_DIR).apply { mkdirs() }
            dir.listFiles { f -> f.name.startsWith(OPENED_PREFIX) }?.forEach { it.delete() }
            File(dir, OPENED_PREFIX + safeFileName(download.fileName ?: fileName.ifBlank { "document.pdf" })).also {
                it.writeBytes(download.bytes)
            }
        }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val intent =
        Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, download.contentType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try {
        context.startActivity(intent)
        OpenResult.Opened
    } catch (e: ActivityNotFoundException) {
        OpenResult.NoApp
    }
}

/** Opens a link in the browser; false when nothing on the phone handles it. */
fun openLink(
    context: Context,
    url: String,
): Boolean {
    if (!url.startsWith("https://", ignoreCase = true) && !url.startsWith("http://", ignoreCase = true)) return false
    return try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}

/** Puts [text] on the clipboard; [sensitive] keeps it out of the clipboard preview where the system supports it. */
fun copyToClipboard(
    context: Context,
    label: String,
    text: String,
    sensitive: Boolean = false,
) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText(label, text)
    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    clipboard.setPrimaryClip(clip)
}
