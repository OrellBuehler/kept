package ch.orellbuehler.kept.ui.reports

import ch.orellbuehler.kept.model.ReportAccount
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReportsLogicTest {
    private val sample = "ABCDEFGHIJKLMNOPQRSTU"

    private val accounts =
        listOf(
            ReportAccount("a", "Checking", "CHF", sample),
            ReportAccount("b", "Old", "CHF", archived = true),
        )

    @Test
    fun theDefaultPeriodIsTheLastFullMonth() {
        assertEquals("2026-10-01" to "2026-10-31", lastFullMonth("2026-11-21"))
        assertEquals("2025-12-01" to "2025-12-31", lastFullMonth("2026-01-05"))
        assertEquals("2024-02-01" to "2024-02-29", lastFullMonth("2024-03-31"))
    }

    @Test
    fun rangeIsInvalidOnlyWhenStartIsAfterEnd() {
        assertTrue(rangeInvalid("2026-02-01", "2026-01-01"))
        assertFalse(rangeInvalid("2026-01-01", "2026-01-01"))
        assertFalse(rangeInvalid("", "2026-01-01"))
    }

    @Test
    fun archivedAccountsAreHiddenUnlessAsked() {
        assertEquals(listOf("a"), visibleAccounts(accounts, false).map { it.id })
        assertEquals(listOf("a", "b"), visibleAccounts(accounts, true).map { it.id })
    }

    @Test
    fun aStatementNeedsAnAccountAndAValidPeriod() {
        assertTrue(canDownloadStatement(accounts, "a", "2026-10-01", "2026-10-31"))
        assertFalse(canDownloadStatement(accounts, "", "2026-10-01", "2026-10-31"))
        assertFalse(canDownloadStatement(accounts, "zzz", "2026-10-01", "2026-10-31"))
        assertFalse(canDownloadStatement(accounts, "a", "2026-11-01", "2026-10-31"))
        assertFalse(canDownloadStatement(accounts, "a", "", "2026-10-31"))
    }

    @Test
    fun queriesCarryTheParametersTheServerReads() {
        assertEquals(mapOf("account" to "a", "from" to "2026-10-01", "to" to "2026-10-31"), statementQuery("a", "2026-10-01", "2026-10-31"))
        assertEquals(mapOf("year" to "2025"), yearQuery(2025))
        assertEquals(emptyMap(), netWorthQuery(false))
        assertEquals(mapOf("basis" to "share"), netWorthQuery(true))
    }

    @Test
    fun yearsAreFourDigitsInTheServersRange() {
        assertEquals(2026, parseYear(" 2026 "))
        assertNull(parseYear("26"))
        assertNull(parseYear("1899"))
        assertNull(parseYear("2201"))
        assertNull(parseYear("20x6"))
    }

    @Test
    fun ibansFollowTheDisplayPreference() {
        assertEquals("ABCD EFGH IJKL MNOP QRST U", ibanLabel(sample.lowercase(), "full"))
        assertEquals("ABCD •••• •••• •••• •RST U", ibanLabel(sample, "masked"))
        assertNull(ibanLabel(sample, "hidden"))
        assertNull(ibanLabel(null, "full"))
        assertNull(ibanLabel("", "full"))
    }

    @Test
    fun fileNamesCannotEscapeTheDirectory() {
        assertEquals("kept-statement-2026-11-21.pdf", safeFileName("kept-statement-2026-11-21.pdf", "x.pdf"))
        assertEquals("passwd", safeFileName("../../etc/passwd", "x.pdf"))
        assertEquals("a_b.pdf", safeFileName("a b.pdf", "x.pdf"))
        assertEquals("x.pdf", safeFileName(null, "x.pdf"))
        assertEquals("x.pdf", safeFileName("..", "x.pdf"))
    }
}
