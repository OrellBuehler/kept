package ch.orellbuehler.kept.ui.pillar3a

import ch.orellbuehler.kept.model.Contract
import ch.orellbuehler.kept.model.Pillar3aContribution
import ch.orellbuehler.kept.model.Pillar3aGap
import ch.orellbuehler.kept.model.Pillar3aPage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class Pillar3aLogicTest {
    private val page = Contract.page<Pillar3aPage>("pillar-3a")
    private val detected = page.contributions.first { it.isDetected && it.id != null && !it.isBuyIn }
    private val plain = page.contributions.first { it.isDetected && it.id == null }
    private val manual = page.contributions.first { !it.isDetected }

    @Test
    fun yearFormSendsTheIncomeOnlyForTheLargeDeduction() {
        val large = YearFormValues("large", " 90000.00 ").fields(2026).toMap()
        assertEquals("90000.00", large["earnedIncome"])
        assertEquals("2026", large["year"])
        assertEquals("", YearFormValues("small", "123").fields(2026).toMap()["earnedIncome"])
    }

    @Test
    fun yearFormIsPrefilledFromTheYear() {
        val values = YearFormValues.of(page.overview.years.first())
        assertEquals("large", values.deduction)
        assertEquals("90000.00", values.earnedIncome)
        assertEquals("", YearFormValues.of(page.overview.years.last()).earnedIncome)
    }

    @Test
    fun addsAManualContribution() {
        val values = ContributionFormValues("p1", " 1'000.50 ", "2026-03-01", "ordinary", setOf(2025), " note ")
        val fields = values.fields(null).toMap()
        assertEquals(setOf("portfolioId", "amount", "date", "kind", "gapYears", "note"), fields.keys)
        assertEquals("1'000.50", fields["amount"])
        assertEquals("", fields["gapYears"])
        assertEquals("note", fields["note"])
    }

    @Test
    fun aBuyInSendsItsGapYearsSorted() {
        val values = ContributionFormValues("p1", "10", "2026-03-01", "buy_in", setOf(2026, 2025))
        assertEquals("2025,2026", values.fields(null).toMap()["gapYears"])
    }

    @Test
    fun editingADetectedPaymentSendsTheTransactionOnly() {
        val values = ContributionFormValues.of(detected, null, "p1", "2026-11-21")
        val fields = values.fields(detected).toMap()
        assertEquals(setOf("transactionId", "date", "kind", "gapYears", "note"), fields.keys)
        assertEquals(detected.transactionId, fields["transactionId"])
        assertEquals(detected.date, fields["date"])
    }

    @Test
    fun editingAManualContributionSendsItsIdAndAmount() {
        val values = ContributionFormValues.of(manual, null, "p1", "2026-11-21")
        val fields = values.fields(manual).toMap()
        assertEquals(manual.id, fields["contributionId"])
        assertEquals(manual.portfolioId, fields["portfolioId"])
        assertEquals("5258.00", fields["amount"])
        assertEquals(setOf("contributionId", "portfolioId", "amount", "date", "kind", "gapYears", "note"), fields.keys)
    }

    @Test
    fun markAsBuyInPresetsTheKind() {
        assertEquals("buy_in", ContributionFormValues.of(plain, "buy_in", "p1", "2026-11-21").kind)
        assertEquals("ordinary", ContributionFormValues.of(plain, null, "p1", "2026-11-21").kind)
        val fresh = ContributionFormValues.of(null, null, "p1", "2026-11-21")
        assertEquals("p1", fresh.portfolioId)
        assertEquals("2026-11-21", fresh.date)
    }

    @Test
    fun deleteFieldsDependOnTheSource() {
        assertEquals(listOf("transactionId" to detected.transactionId!!), deleteFields(detected))
        assertEquals(listOf("contributionId" to manual.id!!), deleteFields(manual))
        assertEquals(listOf("transactionId" to plain.transactionId!!), deleteFields(plain))
        assertNull(deleteFields(Pillar3aContribution(key = "c:x", source = "manual")))
    }

    @Test
    fun gapCandidatesAreOpenYearsPlusTheOnesTheEditedBuyInHolds() {
        val gaps = listOf(Pillar3aGap(2025, closedBy = "a"), Pillar3aGap(2024, closedBy = "b"), Pillar3aGap(2023))
        assertEquals(listOf(2023), gapCandidates(gaps, null).map { it.year })
        val editing = Pillar3aContribution(key = "c:a", id = "a", source = "manual")
        assertEquals(listOf(2025, 2023), gapCandidates(gaps, editing).map { it.year })
    }

    @Test
    fun filtersContributionsByYear() {
        assertEquals(listOf(2026, 2025), contributionYears(page.contributions))
        assertEquals(4, visibleContributions(page.contributions, null).size)
        assertEquals(2, visibleContributions(page.contributions, 2026).size)
    }

    @Test
    fun listsOpenPortfoliosBeforeClosedOnes() {
        val ordered = orderedPortfolios(page.overview.portfolios.reversed())
        assertNull(ordered.first().closedOn)
        assertTrue(ordered.last().closedOn != null)
    }

    @Test
    fun limitFractionStaysInRange() {
        val years = page.overview.years
        assertEquals(300000f / 1800000f, limitFraction(years.first()))
        assertEquals(0f, limitFraction(years.first().copy(limit = 0)))
        assertEquals(1f, limitFraction(years.first().copy(ordinary = 9_000_000)))
    }

    @Test
    fun buyInCheckOnlyRunsForABuyInWithAnAmountAndDate() {
        val values = ContributionFormValues("p1", "100", "2026-03-01", "buy_in", setOf(2025))
        val query = buyInCheckQuery(values, null)!!
        assertEquals(mapOf("date" to "2026-03-01", "amount" to "100", "gapYears" to "2025"), query)
        assertEquals("c:x", buyInCheckQuery(values, manual.copy(key = "c:x"))!!["key"])
        assertNull(buyInCheckQuery(values.copy(kind = "ordinary"), null))
        assertNull(buyInCheckQuery(values.copy(amount = ""), null))
        assertNull(buyInCheckQuery(values.copy(date = ""), null))
    }
}
