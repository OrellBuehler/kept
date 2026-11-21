package ch.orellbuehler.kept.ui.accounts

import ch.orellbuehler.kept.model.AccountDetailCategory
import ch.orellbuehler.kept.model.AccountImportImpact
import ch.orellbuehler.kept.model.AccountsAccount
import ch.orellbuehler.kept.model.AccountsInstitution
import ch.orellbuehler.kept.model.InstitutionRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AccountsLogicTest {
    // Any string will do for the display functions: no account numbers in the tests.
    private val iban = "account-0123456789"

    @Test
    fun showsAnIbanAsThePreferenceSays() {
        assertEquals("ACCO UNT- 0123 4567 89", displayIban(iban, "full"))
        assertEquals("ACCO •••• •••• ••67 89", displayIban(iban, "masked"))
        assertNull(displayIban(iban, "hidden"))
    }

    @Test
    fun masksAllButTheEnds() {
        assertEquals("ACCO •••• •••• ••67 89", maskIban(iban))
        assertEquals("•••• •••• •", maskIban("ABC123456"))
        assertEquals(normalizeIban(iban).length, maskIban(iban).replace(" ", "").length)
    }

    @Test
    fun recognisesOnlyQrIbans() {
        assertFalse(isQrIban(iban))
        assertFalse(isQrIban(""))
    }

    @Test
    fun spacesPaymentReferences() {
        assertEquals("21 00000 00003 13947 14300 09017", formatReference("210000000003139471430009017"))
        assertEquals("not a reference", formatReference(" not a reference "))
    }

    @Test
    fun takesAShareOfAnAmountRoundingAwayFromZero() {
        assertEquals(3L, shareOf(5, 5000))
        assertEquals(-3L, shareOf(-5, 5000))
        assertEquals(1_000L, shareOf(1_000, 10_000))
        assertEquals(333L, shareOf(1_000, 3333))
        assertEquals(0L, shareOf(0, 5000))
        assertEquals(4_503_599_627_370_496L, shareOf(9_007_199_254_740_991L, 5000))
    }

    @Test
    fun writesTheShareAsTheFormTakesIt() {
        assertEquals("50", shareToInput(5000))
        assertEquals("33.33", shareToInput(3333))
        assertEquals("33.5", shareToInput(3350))
        assertEquals("100", shareToInput(10_000))
        assertEquals("0.05", shareToInput(5))
        assertEquals("33.33%", formatShare(3333))
    }

    private fun account(
        id: String,
        institution: String?,
        currency: String = "CHF",
        balance: Long = 100,
        archived: Boolean = false,
        shareBps: Int = 10_000,
        lastImportAt: Long? = null,
    ) = AccountsAccount(
        id = id,
        name = id,
        currency = currency,
        balance = balance,
        shareBalance = shareOf(balance, shareBps),
        archived = archived,
        shareBps = shareBps,
        institution = institution?.let { InstitutionRef(it, it) },
        lastImportAt = lastImportAt,
    )

    private val bank = AccountsInstitution(id = "bank", name = "Bank", accountCount = 2)
    private val empty = AccountsInstitution(id = "empty", name = "Empty")

    @Test
    fun groupsAccountsUnderTheirInstitutions() {
        val accounts = listOf(account("a", "bank"), account("b", "bank", archived = true), account("c", null))
        val groups = groupByInstitution(listOf(bank, empty), accounts, showArchived = false)
        assertEquals(listOf("bank", "empty", null), groups.map { it.institution?.id })
        assertEquals(listOf("a"), groups[0].accounts.map { it.id })
        assertTrue(groups[1].accounts.isEmpty())
        assertEquals(listOf("c"), groups[2].accounts.map { it.id })
        val all = groupByInstitution(listOf(bank, empty), accounts, showArchived = true)
        assertEquals(listOf("a", "b"), all[0].accounts.map { it.id })
    }

    @Test
    fun leavesOutTheGroupOfAccountsWithoutInstitutionWhenThereAreNone() {
        val groups = groupByInstitution(listOf(bank), listOf(account("a", "bank")), showArchived = false)
        assertEquals(1, groups.size)
    }

    @Test
    fun sumsActiveAccountsPerCurrency() {
        val accounts =
            listOf(
                account("a", "bank", balance = 100),
                account("b", "bank", balance = 200, shareBps = 5000),
                account("c", "bank", currency = "EUR", balance = 50),
                account("d", "bank", balance = 1_000, archived = true),
            )
        val totals = currencyTotals(accounts)
        assertEquals(listOf("CHF", "EUR"), totals.map { it.currency })
        assertEquals(300L, totals[0].sum)
        assertEquals(200L, totals[0].share)
        assertTrue(totals[0].shared)
        assertEquals(50L, totals[1].sum)
        assertFalse(totals[1].shared)
    }

    @Test
    fun flagsOldImportsOnly() {
        val now = 1_000L * 86_400_000L
        assertNull(staleImportDays(null, now))
        assertNull(staleImportDays(now - 45L * 86_400_000L, now))
        assertEquals(46, staleImportDays(now - 46L * 86_400_000L - 1, now))
        assertNull(staleImportDays(now + 1_000, now))
    }

    @Test
    fun labelsSubcategoriesWithTheirParent() {
        val food = AccountDetailCategory(id = "food", name = "Food")
        val groceries = AccountDetailCategory(id = "g", name = "Groceries", parentId = "food")
        val orphan = AccountDetailCategory(id = "o", name = "Orphan", parentId = "gone")
        val all = listOf(food, groceries, orphan)
        assertEquals("Food", categoryLabel(food, all))
        assertEquals("Food / Groceries", categoryLabel(groceries, all))
        assertEquals("Orphan", categoryLabel(orphan, all))
    }

    @Test
    fun listsOnlyKindsOfEditsThatWouldBeLost() {
        val lines = describeImpact(AccountImportImpact(transactions = 5, categorized = 3, notes = 0, mirrors = 2))
        assertEquals(listOf(ImpactKind.CATEGORIZED, ImpactKind.MIRRORS), lines.map { it.kind })
        assertEquals(listOf(3, 2), lines.map { it.count })
        assertTrue(describeImpact(AccountImportImpact(transactions = 7)).isEmpty())
    }

    @Test
    fun namesATransactionByItsCounterpartyThenItsDescription() {
        val both =
            ch.orellbuehler.kept.model
                .AccountDetailTx(id = "t", counterpartyName = "Shop", description = "Weekly")
        assertEquals("Shop", transactionTitle(both))
        assertEquals("Weekly", transactionSubtitle(both))
        val onlyDescription = both.copy(counterpartyName = null)
        assertEquals("Weekly", transactionTitle(onlyDescription))
        assertNull(transactionSubtitle(onlyDescription))
        assertNull(transactionTitle(both.copy(counterpartyName = " ", description = null)))
    }
}
