package ch.orellbuehler.kept.model

import ch.orellbuehler.kept.ui.imports.MappingForm
import ch.orellbuehler.kept.ui.imports.toView
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ImportsContractTest {
    @Test
    fun decodesTheImportPage() {
        val page = Contract.page<ImportPage>("import")
        assertTrue(page.accounts.isNotEmpty())
        assertTrue(page.accounts.all { it.id.isNotEmpty() && it.currency.isNotEmpty() })
        assertTrue(page.accounts.any { it.institution != null && it.institutionName != null })
        assertTrue(page.accounts.any { it.institution == null && it.institutionName == null })
        assertEquals(page.accounts.first().id, page.selectedAccountId)
        assertTrue(page.recentImports.isNotEmpty())
        assertTrue(page.recentImports.all { it.id.isNotEmpty() && it.fileName.isNotEmpty() && it.createdAt > 0 })
        assertTrue(page.recentImports.any { it.format == "csv" })
        assertTrue(page.recentImports.any { it.statementFrom != null && it.statementTo != null })
    }

    @Test
    fun decodesTheWatchFolder() {
        val inbox = Contract.page<ImportPage>("import").inbox
        assertTrue(inbox.enabled)
        val scan = assertNotNull(inbox.lastScan)
        assertTrue(scan.at > 0)
        assertEquals(1, scan.review)
        assertEquals(setOf("imported", "review", "failed", "duplicate"), inbox.entries.map { it.status }.toSet())
        val review = inbox.entries.first { it.status == "review" }
        assertNotNull(review.reason)
        assertNotNull(review.accountName)
        assertNull(review.newCount)
        val imported = inbox.entries.first { it.status == "imported" }
        assertEquals(1, imported.newCount)
        assertEquals(0, imported.duplicateCount)
        assertNull(inbox.entries.first { it.status == "failed" }.accountName)
    }

    @Test
    fun aServerWithoutAWatchFolderIsDisabled() {
        val page =
            decodePage<ImportPage>("""{"accounts":[],"recentImports":[],"inbox":{"enabled":false,"entries":[]},"selectedAccountId":null}""")
        assertFalse(page.inbox.enabled)
        assertNull(page.inbox.lastScan)
        assertNull(page.selectedAccountId)
    }

    @Test
    fun decodesThePreviewOfAStatement() {
        val page = Contract.page<ImportPendingPage>("import.pendingId")
        assertTrue(page.pendingId.isNotEmpty())
        assertEquals("CHF", page.account.currency)
        assertNotNull(page.account.iban)
        assertEquals("camt053", page.format)
        assertEquals("overlap-b.xml", page.fileName)
        val statement = assertNotNull(page.statement)
        assertEquals("2024-07-05", statement.fromDate)
        assertEquals("2024-07-15", statement.toDate)
        assertEquals(108000L, statement.openingBalance?.amount)
        assertEquals("CHF", statement.closingBalance?.currency)
        assertEquals(118750L, statement.closingBalance?.amount)
        assertEquals(5, page.counts.total)
        assertEquals(2, page.counts.new)
        assertEquals(3, page.counts.duplicate)
        assertEquals(0, page.counts.replacesMirror)
        assertEquals(setOf("new", "duplicate"), page.rows.map { it.status }.toSet())
        assertTrue(page.rows.all { it.tx.currency == "CHF" && it.tx.bookingDate.length == 10 })
        assertEquals(
            -3550L,
            page.rows
                .first()
                .tx.amount,
        )
        assertEquals(
            "Sample Insurance AG",
            page.rows
                .first()
                .tx.counterpartyName,
        )
        assertEquals("id", page.rows.first().matchedBy)
        assertTrue(page.canConfirm)
        assertFalse(page.needsMapping)
        assertTrue(page.errors.isEmpty())
        assertNull(page.alreadyImportedAt)
        assertEquals("all", page.filter)
        assertEquals(1, page.page)
        assertEquals(100, page.pageSize)
        assertEquals(1, page.pageCount)
        assertEquals(5, page.filteredTotal)
    }

    @Test
    fun decodesThePreviewOfAFileThatNeedsAMapping() {
        val page = Contract.page<ImportPendingPage>("import.pendingId.needs-mapping")
        assertEquals("csv", page.format)
        assertNull(page.account.iban)
        assertNull(page.statement)
        assertTrue(page.rows.isEmpty())
        assertEquals(listOf("mapping_required"), page.errors)
        assertTrue(page.needsMapping)
        assertFalse(page.canConfirm)
        assertEquals(0, page.counts.total)
    }

    @Test
    fun decodesWarningsMirrorsAndTheEarlierImport() {
        val page =
            decodePage<ImportPendingPage>(
                """
                {"pendingId":"p","account":{"id":"a","name":"Example","currency":"CHF","iban":null},"format":"mt940","fileName":"x.sta",
                 "statement":{"fromDate":null,"toDate":null,"openingBalance":null,"closingBalance":null},
                 "rows":[{"index":1,"status":"replaces_mirror","matchedBy":null,"mirrorId":"m","tx":{"bookingDate":"2025-01-02","amount":500,"currency":"CHF"}},
                         {"index":2,"status":"duplicate","matchedBy":"legacy_id","mirrorId":null,"tx":{"bookingDate":"2025-01-03","amount":-100,"currency":"CHF","reference":"ref"}}],
                 "counts":{"new":1,"replacesMirror":1,"duplicate":1,"total":2},"warnings":["Something"],
                 "balanceWarnings":[{"code":"opening_mismatch","date":"2025-01-01","fileAmount":100,"ledgerAmount":200,"currency":"CHF"}],
                 "errors":[],"alreadyImportedAt":1700000000000,"filter":"duplicate","page":2,"pageSize":100,"pageCount":3,"filteredTotal":250,
                 "needsMapping":false,"canConfirm":true}
                """.trimIndent(),
            )
        assertEquals("replaces_mirror", page.rows.first().status)
        assertEquals("legacy_id", page.rows.last().matchedBy)
        assertEquals(
            "ref",
            page.rows
                .last()
                .tx.reference,
        )
        assertEquals("opening_mismatch", page.balanceWarnings.single().code)
        assertEquals(200L, page.balanceWarnings.single().ledgerAmount)
        assertEquals(1700000000000, page.alreadyImportedAt)
        assertEquals(250, page.filteredTotal)
        assertNull(page.statement?.openingBalance)
    }

    @Test
    fun decodesTheMappingPage() {
        val page = Contract.page<ImportMappingPage>("import.pendingId.mapping")
        assertEquals("csv", page.format)
        assertEquals("CHF", page.account.currency)
        assertEquals(5, page.detected.size)
        assertEquals("Amount", page.detected[3].name)
        assertEquals(3, page.detected[3].index)
        assertTrue(page.detected.all { it.samples.isNotEmpty() })
        assertEquals(6, page.sampleRows.size)
        assertEquals(listOf("Date", "Counterparty", "Description", "Amount", "Currency"), page.sampleRows.first())
        assertEquals(5, page.preview.size)
        assertTrue(page.preview.all { it.transaction != null && it.error == null })
        assertEquals(
            -450L,
            page.preview
                .first()
                .transaction
                ?.amount,
        )
        assertEquals(
            "Coffee",
            page.preview
                .first()
                .transaction
                ?.description,
        )
        assertTrue(page.toView().valid)
        assertFalse(page.saved)
        assertNull(page.savedName)
        assertEquals(6, page.rowCount)
        assertEquals(5, page.dataRowCount)
        assertTrue(page.errors.isEmpty())
        val other = page.otherProfiles.single()
        assertEquals("Example export", other.name)
        assertTrue(other.accountName.isNotEmpty())
        assertEquals(JsonPrimitive("single"), other.profile["amountMode"])
    }

    @Test
    fun theDraftOfThePageBecomesTheForm() {
        val page = Contract.page<ImportMappingPage>("import.pendingId.mapping")
        val form = MappingForm.fromProfile(page.draft)
        assertEquals("Amount", form.column("amount"))
        assertEquals("Date", form.column("bookingDate"))
        assertEquals(listOf("Description"), form.description)
        assertEquals("CHF", form.defaultCurrency)
        assertEquals("single", form.amountMode)
        val profile = form.toProfile()
        val columns = profile["columns"] as JsonObject
        assertEquals(JsonPrimitive("Amount"), columns["amount"])
        assertEquals(JsonPrimitive(1), profile["headerRow"])
    }

    @Test
    fun theLivePreviewAnswersWithoutOtherProfilesAndWithErrorRows() {
        val result =
            decodePage<ImportMappingPage>(
                """
                {"pendingId":"p","fileName":"f.csv","format":"csv","account":{"id":"a","name":"Example","currency":"CHF"},
                 "detected":[{"index":0,"name":"","samples":["1"]}],"sampleRows":[["1"]],
                 "preview":[{"rowNumber":2,"raw":["x"],"error":"Row 2: invalid date"}],
                 "profile":null,"draft":{"amountMode":"single","columns":{"bookingDate":0}},"saved":false,"savedName":null,
                 "rowCount":1,"dataRowCount":0,"errors":["Either columns.currency or defaultCurrency is required"]}
                """.trimIndent(),
            )
        assertFalse(result.toView().valid)
        assertTrue(result.otherProfiles.isEmpty())
        assertEquals("Row 2: invalid date", result.preview.single().error)
        assertNull(result.preview.single().transaction)
        assertEquals(1, result.errors.size)
        assertEquals("0", MappingForm.fromProfile(result.draft).column("bookingDate"))
    }
}
