package ch.orellbuehler.kept.ui.accounts

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast

/** Copies [text] to the clipboard and says so with [confirmation]. */
internal fun copyToClipboard(
    context: Context,
    text: String,
    confirmation: String,
) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("", text))
    Toast.makeText(context, confirmation, Toast.LENGTH_SHORT).show()
}
