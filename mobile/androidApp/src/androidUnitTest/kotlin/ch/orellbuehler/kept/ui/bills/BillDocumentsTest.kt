package ch.orellbuehler.kept.ui.bills

import android.media.ExifInterface
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BillDocumentsTest {
    @Test
    fun theLimitIsTheServers() {
        assertEquals(20 * 1024 * 1024L, MAX_DOCUMENT_BYTES)
    }

    @Test
    fun aPhotoIsFittedToTheWidthOfAnA4Page() {
        assertEquals(595 to 446, pdfPageSize(4000, 3000))
        assertEquals(595 to 793, pdfPageSize(3000, 4000))
        assertEquals(595 to 595, pdfPageSize(0, 0))
    }

    @Test
    fun largeImagesAreSampledDownToTheTargetSide() {
        assertEquals(1, imageSampleSize(2000, 1500, 2400))
        assertEquals(1, imageSampleSize(4000, 3000, 2400))
        assertEquals(2, imageSampleSize(6000, 4000, 2400))
        assertEquals(4, imageSampleSize(12000, 9000, 2400))
        assertEquals(8, imageSampleSize(12000, 9000, 1200))
    }

    @Test
    fun exifOrientationBecomesARotation() {
        assertEquals(90, exifRotation(ExifInterface.ORIENTATION_ROTATE_90))
        assertEquals(180, exifRotation(ExifInterface.ORIENTATION_ROTATE_180))
        assertEquals(270, exifRotation(ExifInterface.ORIENTATION_ROTATE_270))
        assertEquals(0, exifRotation(ExifInterface.ORIENTATION_NORMAL))
    }

    @Test
    fun fileNamesAreSafeInTheCacheDirectory() {
        assertEquals("invoice-2001.pdf", safeFileName("invoice-2001.pdf"))
        assertEquals("IMG_1.pdf", safeFileName("IMG 1.jpg", "pdf"))
        assertEquals("document.pdf", safeFileName("???", "pdf"))
        assertFalse(safeFileName("../../etc/passwd").contains('/'))
        assertTrue(safeFileName("x".repeat(300)).length <= 60)
    }
}
