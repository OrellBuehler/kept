package ch.orellbuehler.kept.ui.taxes

import ch.orellbuehler.kept.model.Contract
import ch.orellbuehler.kept.model.TaxYearPage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TaxLogicTest {
    private val page = Contract.page<TaxYearPage>("taxes.year")

    @Test
    fun yearFormFieldsAreUpperCasedAndTrimmed() {
        val fields = TaxYearFormValues("2025 ", " Example Office ", "chf", " 3000.00", " note ").fields().toMap()
        assertEquals("2025", fields["year"])
        assertEquals("Example Office", fields["authority"])
        assertEquals("CHF", fields["currency"])
        assertEquals("3000.00", fields["assessedTotal"])
        assertEquals("note", fields["notes"])
    }

    @Test
    fun newYearFormStartsWithTheSuggestedYear() {
        val values = TaxYearFormValues.forNewYear(2025, "CHF")
        assertEquals("2025", values.year)
        assertEquals("CHF", values.currency)
        assertEquals("", values.assessedTotal)
    }

    @Test
    fun detailsFormIsPrefilledFromTheYear() {
        val values = TaxYearFormValues.of(page.reconciliation.year)
        assertEquals("2025", values.year)
        assertEquals("Example Tax Office", values.authority)
        assertEquals("5500.00", values.assessedTotal)
        assertEquals(page.reconciliation.year.notes, values.notes)
        val bare = TaxYearFormValues.of(page.reconciliation.year.copy(authority = null, assessedTotal = null, notes = null))
        assertEquals("", bare.authority)
        assertEquals("", bare.assessedTotal)
        assertEquals("", bare.notes)
    }

    @Test
    fun creditFormSendsTheWebFieldNames() {
        val fields = CreditFormValues("2025-03-01", " -50.00 ", " REF ", " text ").fields().toMap()
        assertEquals(setOf("bookingDate", "amount", "reference", "description"), fields.keys)
        assertEquals("-50.00", fields["amount"])
        assertEquals("REF", fields["reference"])
    }

    @Test
    fun countsTheDifferences() {
        assertEquals(5, differenceCount(page.reconciliation.counts))
        assertEquals(0, differenceCount(mapOf("matched" to 3)))
    }

    @Test
    fun findsTheSuggestionsOfAStatementLine() {
        val rec = page.reconciliation
        val credit = rec.rows.first { it.kind == "missing_mine" }.office!!
        assertEquals(1, suggestionsFor(rec, credit).size)
        assertTrue(suggestionsFor(rec, rec.rows.first { it.kind == "matched" }.office!!).isEmpty())
    }

    @Test
    fun mappingChoicesStartWithNone() {
        assertEquals("", mappingChoices().first())
        assertEquals(deductionTypes, mappingChoices().drop(1))
    }

    @Test
    fun knowsWhichMappingsAreInherited() {
        val byName = page.deductionMappings.associateBy { it.name }
        assertTrue(mappingIsInherited(byName.getValue("Pharmacy")))
        assertFalse(mappingIsInherited(byName.getValue("Health")))
        assertFalse(mappingIsInherited(byName.getValue("Food")))
    }
}
