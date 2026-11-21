package ch.orellbuehler.kept

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.create

/** The file as `Data`, copied in one go (a byte-by-byte copy in Swift is slow for a PDF). */
@OptIn(ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)
fun Download.toNSData(): NSData {
    if (bytes.isEmpty()) return NSData()
    return bytes.usePinned { pinned -> NSData.create(bytes = pinned.addressOf(0), length = bytes.size.toULong()) }
}
