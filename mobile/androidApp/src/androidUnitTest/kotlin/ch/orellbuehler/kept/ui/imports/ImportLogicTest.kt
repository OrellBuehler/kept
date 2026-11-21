package ch.orellbuehler.kept.ui.imports

import ch.orellbuehler.kept.model.ImportAccount
import ch.orellbuehler.kept.model.ImportCounts
import ch.orellbuehler.kept.model.ImportPendingAccount
import ch.orellbuehler.kept.model.ImportPendingPage
import ch.orellbuehler.kept.model.ImportTx
import ch.orellbuehler.kept.ui.common.Formats
import java.io.ByteArrayInputStream
import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ImportLogicTest {
    private fun page(
        canConfirm: Boolean = true,
        counts: ImportCounts = ImportCounts(new = 2, duplicate = 3, total = 5),
    ) = ImportPendingPage(pendingId = "p", account = ImportPendingAccount("a"), counts = counts, canConfirm = canConfirm)

    @Test
    fun accountsAreLabelledWithCurrencyAndInstitution() {
        val accounts =
            listOf(
                ImportAccount("a", "Example Checking", "CHF", "Example Bank"),
                ImportAccount("b", "Example Wallet", "CHF", null),
            )
        assertEquals(
            listOf("a" to "Example Checking (CHF) · Example Bank", "b" to "Example Wallet (CHF)"),
            accountChoices(accounts).map {
                it.value to
                    it.label
            },
        )
    }

    @Test
    fun theStartingAccountIsThePreselectedOrTheOnlyOne() {
        val two = listOf(ImportAccount("a"), ImportAccount("b"))
        assertEquals("b", initialAccountId(two, "b"))
        assertEquals("", initialAccountId(two, null))
        assertEquals("", initialAccountId(two, "missing"))
        assertEquals("a", initialAccountId(listOf(ImportAccount("a")), null))
        assertEquals("", initialAccountId(emptyList(), null))
    }

    @Test
    fun formatsAreNamedAsOnTheWeb() {
        assertEquals("camt.053", formatName("camt053"))
        assertEquals("camt.054", formatName("camt054"))
        assertEquals("MT940", formatName("mt940"))
        assertEquals("CSV", formatName("csv"))
        assertEquals("Excel", formatName("xlsx"))
        assertTrue(isTabular("csv") && isTabular("xlsx") && !isTabular("camt053"))
    }

    @Test
    fun fileSizesAreReadable() {
        assertEquals("812 B", formatBytes(812))
        assertEquals("3.4 KB", formatBytes(3482))
        assertEquals("1.5 MB", formatBytes(1_572_864))
    }

    @Test
    fun theStatementPeriodIsOneDateOrARange() {
        val formats = Formats("en-GB")
        assertEquals("5 Jul 2024 – 15 Jul 2024", formatPeriod("2024-07-05", "2024-07-15", formats))
        assertEquals("5 Jul 2024", formatPeriod("2024-07-05", "2024-07-05", formats))
        assertEquals("15 Jul 2024", formatPeriod(null, "2024-07-15", formats))
        assertNull(formatPeriod(null, null, formats))
        assertNull(formatPeriod("", "", formats))
    }

    @Test
    fun instantsShowInTheGivenZone() {
        val text = formatDateTime(1_700_000_000_000, Locale.forLanguageTag("en-GB"), ZoneId.of("UTC"))
        assertTrue(text.contains("14 Nov 2023"), text)
        assertTrue(text.contains("22:13"), text)
    }

    @Test
    fun rowsAreNamedByCounterpartyThenDescription() {
        assertEquals("Sample Cafe", rowTitle(ImportTx(counterpartyName = "Sample Cafe", description = "Coffee")))
        assertEquals("Coffee", rowTitle(ImportTx(description = "Coffee")))
        assertEquals("Coffee", rowTitle(ImportTx(counterpartyName = " ", description = "Coffee")))
        assertEquals("—", rowTitle(ImportTx()))
        assertEquals("Coffee", rowSubtitle(ImportTx(counterpartyName = "Sample Cafe", description = "Coffee")))
        assertNull(rowSubtitle(ImportTx(description = "Coffee")))
    }

    @Test
    fun rowStatusesMapFromTheApi() {
        assertEquals(ImportRowStatus.NEW, ImportRowStatus.fromApi("new"))
        assertEquals(ImportRowStatus.REPLACES_MIRROR, ImportRowStatus.fromApi("replaces_mirror"))
        assertEquals(ImportRowStatus.DUPLICATE, ImportRowStatus.fromApi("duplicate"))
        assertEquals(ImportRowStatus.DUPLICATE_IN_FILE, ImportRowStatus.fromApi("duplicate_in_file"))
        assertEquals(InboxStatus.REVIEW, InboxStatus.fromApi("review"))
        assertEquals(InboxStatus.FAILED, InboxStatus.fromApi("failed"))
        assertEquals(InboxStatus.IMPORTED, InboxStatus.fromApi("imported"))
        assertEquals(InboxStatus.DUPLICATE, InboxStatus.fromApi("duplicate"))
    }

    @Test
    fun filtersCountBrandNewRowsSeparately() {
        val counts = ImportCounts(new = 3, replacesMirror = 1, duplicate = 2, total = 5)
        assertEquals(2, brandNew(counts))
        assertEquals(
            listOf("all" to 5, "new" to 2, "replaces_mirror" to 1, "duplicate" to 2),
            importFilters(counts).map { it.value to it.count },
        )
        assertEquals(listOf("all", "new", "duplicate"), importFilters(ImportCounts(new = 1, duplicate = 1, total = 2)).map { it.value })
    }

    @Test
    fun theQueryHoldsOnlyWhatDiffersFromTheDefaults() {
        assertEquals(emptyMap(), pendingQuery("all", 1))
        assertEquals(mapOf("filter" to "new"), pendingQuery("new", 1))
        assertEquals(mapOf("filter" to "duplicate", "page" to "3"), pendingQuery("duplicate", 3))
        assertEquals(mapOf("page" to "2"), pendingQuery("all", 2))
    }

    @Test
    fun theMissingMappingHasItsOwnButton() {
        assertEquals(listOf("Bad date"), otherErrors(listOf("mapping_required", "Bad date")))
        assertTrue(otherErrors(listOf("mapping_required")).isEmpty())
    }

    @Test
    fun theImportButtonFollowsTheFile() {
        assertEquals(ConfirmState.Import(2), confirmState(page()))
        assertEquals(ConfirmState.NothingNew, confirmState(page(counts = ImportCounts(new = 0, duplicate = 5, total = 5))))
        assertEquals(ConfirmState.Blocked, confirmState(page(canConfirm = false)))
        assertEquals(ConfirmState.Blocked, confirmState(page(canConfirm = false, counts = ImportCounts())))
    }

    @Test
    fun rowRangesFollowThePage() {
        val third =
            ImportPendingPage(
                pendingId = "p",
                account = ImportPendingAccount("a"),
                page = 3,
                pageSize = 100,
                pageCount = 3,
                filteredTotal = 230,
            )
        assertEquals(201 to 230, rowRange(third))
        assertEquals(1 to 100, rowRange(third.copy(page = 1)))
    }

    @Test
    fun readingStopsAtTheLimit() {
        assertContentEquals(byteArrayOf(1, 2, 3), readLimited(ByteArrayInputStream(byteArrayOf(1, 2, 3)), 3))
        assertNull(readLimited(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), 3))
        assertContentEquals(ByteArray(0), readLimited(ByteArrayInputStream(ByteArray(0)), 3))
    }

    @Test
    fun theAppLimitStaysBelowWhatTheBodyLimitAllows() {
        // base64 grows a file by a third and the body limit is 25 MB.
        assertTrue(MAX_IMPORT_BYTES * 4 / 3 < 25L * 1024 * 1024)
        assertTrue(MAX_IMPORT_BYTES < SERVER_IMPORT_LIMIT_MB * 1024L * 1024)
    }
}
