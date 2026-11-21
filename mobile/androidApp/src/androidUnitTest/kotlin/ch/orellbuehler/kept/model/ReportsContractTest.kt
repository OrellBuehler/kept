package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReportsContractTest {
    @Test
    fun decodesTheReportForms() {
        val page = Contract.page<ReportsPage>("reports")
        assertEquals(10, page.today.length)
        assertTrue(page.hasShared)
        assertTrue(page.accounts.isNotEmpty())
        assertTrue(page.accounts.all { it.id.isNotEmpty() && it.name.isNotEmpty() && it.currency.isNotEmpty() })
        assertNotNull(page.accounts.first().iban)
        assertTrue(page.accounts.any { it.iban == null })
        assertTrue(page.accounts.any { it.archived })
        assertNull(page.accounts.first { !it.archived && it.iban == null }.iban)
    }
}
