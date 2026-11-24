package ch.orellbuehler.kept.ui.common

import kotlin.test.Test
import kotlin.test.assertEquals

class FormatsTest {
    private val formats = Formats("en-GB")

    @Test
    fun showsAReturnInBasisPointsAsASignedPercentage() {
        assertEquals("+4.25%", formats.signedPercent(425))
        assertEquals("-1.99%", formats.signedPercent(-199))
        assertEquals("0.00%", formats.signedPercent(0))
        assertEquals("+12.44%", formats.signedPercent(1244))
        assertEquals("+0.01%", formats.signedPercent(1))
        assertEquals("+1,000.00%", formats.signedPercent(100_000))
    }
}
