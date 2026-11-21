package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BillsContractTest {
    @Test
    fun decodesTheBillsOverview() {
        val page = Contract.page<BillsPage>("bills")
        assertEquals(10, page.today.length)
        assertTrue(page.groups.overdue.isNotEmpty())
        assertTrue(page.groups.overdue.all { it.overdue && it.id.isNotEmpty() && it.currency.isNotEmpty() })
        assertTrue(page.groups.dueSoon.isNotEmpty())
        assertTrue(page.groups.awaitingRefund.any { it.isCreditNote })
        assertTrue(page.suggestions.isNotEmpty())
        val suggestion = page.suggestions.first()
        assertTrue(suggestion.billId.isNotEmpty() && suggestion.transactionId.isNotEmpty())
        assertEquals(suggestion.billId, suggestion.bill.id)
        assertTrue(suggestion.transaction.currency.isNotEmpty())
        assertEquals(7, page.counts.total)
        assertEquals("all", page.query.status)
        assertEquals(1, page.list.page)
        assertEquals(page.list.total, page.list.items.size)
        assertTrue(page.list.items.any { it.documentId != null })
        assertTrue(page.list.items.any { it.status == "partially_paid" && it.remaining != null })
        assertFalse(page.matchingFailed)
    }

    @Test
    fun decodesTheNewBillPage() {
        val page = Contract.page<BillNewPage>("bills.new")
        assertTrue(page.accounts.isNotEmpty())
        assertNull(page.draft)
        assertNull(page.documentId)
        assertNull(page.extraction)
    }

    @Test
    fun decodesTheNewBillPageWithADocument() {
        val page = Contract.page<BillNewPage>("bills.new.document")
        assertTrue(page.accounts.all { it.id.isNotEmpty() && it.currency.isNotEmpty() })
        val draft = assertNotNull(page.draft)
        assertEquals("invoice", draft.kind)
        assertEquals("1949.75", draft.amount)
        assertEquals("QRR", draft.referenceType)
        assertNotNull(draft.creditorIban)
        assertNotNull(page.documentId)
        assertEquals("qr", page.extraction?.source)
    }

    @Test
    fun decodesAnOpenBill() {
        val page = Contract.page<BillDetailPage>("bills.id.open")
        val bill = page.bill
        assertEquals("open", bill.status)
        assertEquals("CHF", bill.currency)
        assertEquals(bill.amount, bill.remaining)
        assertNotNull(bill.reference)
        assertNotNull(bill.externalUrl)
        assertEquals("qr", bill.extraction?.source)
        val document = assertNotNull(page.document)
        assertEquals(bill.documentId, document.id)
        assertTrue(document.size > 0)
        assertTrue(page.links.isNotEmpty())
        assertTrue(page.suggestions.isNotEmpty())
        assertTrue(page.dismissed.isNotEmpty())
        assertTrue(page.allocations.isEmpty())
        assertTrue(page.candidates.items.isNotEmpty())
        assertTrue(page.candidates.pageCount > 1)
        assertEquals("", page.candidateQuery)
        assertTrue(page.accounts.isNotEmpty())
    }

    @Test
    fun decodesAPartiallyPaidBill() {
        val page = Contract.page<BillDetailPage>("bills.id.partial")
        assertEquals("partially_paid", page.bill.status)
        assertEquals(25000, page.bill.settled)
        assertEquals(35000, page.bill.remaining)
        assertEquals(1, page.bill.allocationCount)
        assertEquals(1, page.allocations.size)
        assertEquals("user", page.allocations.first().origin)
        assertEquals(
            -25000,
            page.allocations
                .first()
                .transaction.amount,
        )
        assertNull(page.document)
        assertNull(page.bill.creditorIban)
    }

    @Test
    fun decodesAPaidBill() {
        val page = Contract.page<BillDetailPage>("bills.id.paid")
        assertEquals("paid", page.bill.status)
        assertEquals(0, page.bill.remaining)
        assertEquals(2025, page.bill.taxYear)
        assertEquals(1, page.allocations.size)
    }

    @Test
    fun decodesACreditNote() {
        val page = Contract.page<BillDetailPage>("bills.id.credit-note")
        assertTrue(page.bill.isCreditNote)
        assertEquals("credit_due", page.bill.status)
        assertNull(page.bill.dueDate)
        assertNull(page.bill.dueInDays)
        assertTrue(page.candidates.items.any { it.suggestedAmount > 0 })
    }
}
