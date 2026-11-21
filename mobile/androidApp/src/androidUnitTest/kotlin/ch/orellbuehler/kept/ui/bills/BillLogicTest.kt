package ch.orellbuehler.kept.ui.bills

import ch.orellbuehler.kept.model.BillDraft
import ch.orellbuehler.kept.model.BillItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BillLogicTest {
    // Formatting only chunks characters, so the tests use plain letters and digits rather than IBAN-shaped values.
    private val iban = "ABCDEFGHIJKLMNOPQRSTU"
    private val ibanGrouped = "ABCD EFGH IJKL MNOP QRST U"
    private val qrr = "123456789012345678901234567"
    private val qrrGrouped = "12 34567 89012 34567 89012 34567"
    private val scor = "RFABCDEFGH"
    private val scorGrouped = "RFAB CDEF GH"

    private fun bill(
        status: String = "open",
        overdue: Boolean = false,
        dueInDays: Int? = null,
        amount: Long? = 10000,
        remaining: Long? = amount,
    ) = BillItem(
        id = "b",
        currency = "CHF",
        status = status,
        overdue = overdue,
        dueInDays = dueInDays,
        amount = amount,
        remaining = remaining,
    )

    @Test
    fun listQueryContainsOnlyWhatDiffersFromTheDefaults() {
        assertEquals(emptyMap(), billListQuery("", "all", 1))
        assertEquals(mapOf("q" to "dental", "status" to "paid", "page" to "3"), billListQuery(" dental ", "paid", 3))
        assertEquals(emptyMap(), billListQuery("   ", "all", 1))
        assertEquals(mapOf("q" to "x", "page" to "2"), candidateQuery("x", 2))
    }

    @Test
    fun pageRangeCountsRows() {
        assertEquals(0 to 0, pageRange(1, 25, 0))
        assertEquals(1 to 25, pageRange(1, 25, 53))
        assertEquals(51 to 53, pageRange(3, 25, 53))
    }

    @Test
    fun dueHintFollowsTheWeb() {
        assertEquals(DueHint.Overdue(3), dueHint(bill(overdue = true, dueInDays = -3)))
        assertEquals(DueHint.Today, dueHint(bill(dueInDays = 0)))
        assertEquals(DueHint.Tomorrow, dueHint(bill(dueInDays = 1)))
        assertEquals(DueHint.InDays(12), dueHint(bill(status = "partially_paid", dueInDays = 12)))
        assertNull(dueHint(bill(status = "paid", dueInDays = 5)))
        assertNull(dueHint(bill(dueInDays = null)))
        assertNull(dueHint(bill(status = "paid", overdue = false, dueInDays = -9)))
    }

    @Test
    fun remainingIsShownForPartialPaymentsOnly() {
        assertTrue(showsRemaining(bill(status = "partially_paid", remaining = 500)))
        assertEquals(false, showsRemaining(bill()))
        assertEquals(false, showsRemaining(bill(status = "partially_paid", amount = null, remaining = null)))
    }

    @Test
    fun amountToPayIsWhatIsLeft() {
        assertEquals(35000, amountToPay(bill(status = "partially_paid", amount = 60000, remaining = 35000)))
        assertEquals(10000, amountToPay(bill()))
        assertNull(amountToPay(bill(status = "paid", remaining = 0)))
        assertNull(amountToPay(bill(amount = null, remaining = null)))
    }

    @Test
    fun paidAndCancelledBillsCollapseTheMatching() {
        val paid = bill(status = "paid")
        assertTrue(candidatesCollapsed(paid, null, ""))
        assertEquals(false, candidatesCollapsed(paid, "b", ""))
        assertEquals(false, candidatesCollapsed(paid, null, "rent"))
        assertEquals(false, candidatesCollapsed(bill(), null, ""))
    }

    @Test
    fun formatsIbansAndReferences() {
        assertEquals(ibanGrouped, formatIban(iban.lowercase()))
        assertEquals("ABCD •••• •••• •••• •RST U", maskIban(iban))
        assertEquals("•••", maskIban("abc"))
        assertEquals(qrrGrouped, formatReference(qrr))
        assertEquals(scorGrouped, formatReference(scor.lowercase()))
        assertEquals("free text", formatReference(" free text "))
        assertEquals(iban, compact(ibanGrouped.lowercase()))
    }

    @Test
    fun findsTheDocumentOfAnUploadRedirect() {
        assertEquals("abc-1", documentIdOfRedirect("/bills/new?document=abc-1"))
        assertNull(documentIdOfRedirect("/bills/xyz"))
        assertNull(documentIdOfRedirect("/bills/new"))
        assertNull(documentIdOfRedirect("/bills/new?document="))
    }

    @Test
    fun theFormSendsEveryFieldOfTheWebForm() {
        val names = BillFormValues().fields().map { it.first }
        assertEquals(
            listOf(
                "kind",
                "creditorName",
                "creditorIban",
                "amount",
                "currency",
                "issueDate",
                "dueDate",
                "reference",
                "referenceType",
                "message",
                "invoiceNumber",
                "expectedAccountId",
                "notes",
                "taxYear",
            ),
            names,
        )
        assertEquals(names.toSet(), billFormFieldNames - "documentId")
        val values = BillFormValues(creditorName = "A", amount = "12.50", taxYear = "2025")
        assertEquals(values, BillFormValues.of(values.toList()))
    }

    @Test
    fun errorsOfUnknownFieldsBecomeTheFormError() {
        assertEquals("boom", billFormError(mapOf("form" to "boom", "amount" to "x")))
        assertEquals("nope", billFormError(mapOf("amount" to "x", "id" to "nope")))
        assertNull(billFormError(mapOf("amount" to "x")))
    }

    @Test
    fun aBillFillsTheEditForm() {
        val values =
            billToFormValues(
                BillItem(
                    id = "b",
                    kind = "credit_note",
                    creditorName = "Example AG",
                    creditorIban = iban,
                    amount = 194975,
                    currency = "CHF",
                    reference = qrr,
                    referenceType = "QRR",
                    taxYear = 2025,
                    expectedAccountId = "acc",
                ),
            )
        assertEquals("credit_note", values.kind)
        assertEquals("1949.75", values.amount)
        assertEquals(ibanGrouped, values.creditorIban)
        assertEquals(qrrGrouped, values.reference)
        assertEquals("2025", values.taxYear)
        assertEquals("", values.dueDate)
        assertEquals("acc", values.expectedAccountId)
    }

    @Test
    fun aDraftFillsTheNewForm() {
        val empty = draftToFormValues(null, "EUR")
        assertEquals("EUR", empty.currency)
        assertEquals("invoice", empty.kind)
        val values =
            draftToFormValues(
                BillDraft(creditorName = "Example", amount = "10.00", currency = "CHF", creditorIban = iban),
                "EUR",
            )
        assertEquals("CHF", values.currency)
        assertEquals("10.00", values.amount)
        assertEquals(ibanGrouped, values.creditorIban)
        assertEquals("EUR", draftToFormValues(BillDraft(creditorName = "x"), "EUR").currency)
    }

    @Test
    fun aRereadOnlyReplacesWhatTheDocumentYielded() {
        val base = BillFormValues(creditorName = "Old", amount = "5.00", currency = "CHF", message = "keep", kind = "credit_note")
        val draft = BillDraft(kind = "invoice", creditorName = "New", amount = "", currency = "EUR", reference = scor.lowercase())
        val text = mergeRereadDraft(base, draft, "text", hasAllocations = false)
        assertEquals("New", text.creditorName)
        assertEquals("5.00", text.amount)
        assertEquals("keep", text.message)
        assertEquals("credit_note", text.kind)
        assertEquals("CHF", text.currency)
        assertEquals(scorGrouped, text.reference)
        assertEquals("EUR", mergeRereadDraft(base, draft, "qr", hasAllocations = false).currency)
        assertEquals("CHF", mergeRereadDraft(base, draft, "qr", hasAllocations = true).currency)
    }
}
