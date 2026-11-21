package ch.orellbuehler.kept.ui.accounts

import ch.orellbuehler.kept.model.AccountDetailCategory
import ch.orellbuehler.kept.model.AccountDetailPortfolio
import ch.orellbuehler.kept.model.AccountDetailTrade
import ch.orellbuehler.kept.model.AccountDetailTx
import ch.orellbuehler.kept.model.AccountsAccount
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AccountFormsTest {
    private fun fields(sent: Map<String, String>): Map<String, String> = sent

    @Test
    fun sendsAPillar3aAccountLikeTheWebForm() {
        val form =
            AccountDraft(
                name = "Retirement",
                type = "pillar_3a",
                currency = "CHF",
                contractNumber = "EX-1",
                depositIban = "DEPOSIT-ACCOUNT-1",
                share = "50",
                sharedWith = "Someone",
                noticeMonths = "3",
                fillFromTransfers = true,
                tradesMoveCash = true,
            ).toFields(hasPortfolios = false, hasTrades = false)
        val sent = fields(form)
        assertEquals("pillar_3a", sent["type"])
        assertEquals("1", sent["fillFromTransfersField"])
        assertEquals("EX-1", sent["contractNumber"])
        assertEquals("DEPOSIT-ACCOUNT-1", sent["depositIban"])
        assertFalse("share" in sent)
        assertFalse("sharedWith" in sent)
        assertFalse("noticeMonths" in sent)
        assertFalse("fillFromTransfers" in sent)
        assertFalse("tradesMoveCash" in sent)
        assertFalse("confirmRemoveMirrors" in sent)
    }

    @Test
    fun sendsNoticeAndCheckboxesWhereTheyApply() {
        val draft =
            AccountDraft(
                name = "Savings",
                type = "savings",
                currency = "CHF",
                institutionId = "bank",
                openingBalance = "-120.50",
                share = "33.33",
                noticeMonths = "3",
                freeWithdrawal = "5000",
                freeWithdrawalPeriod = "year",
                fillFromTransfers = true,
                tradesMoveCash = true,
            )
        val sent = draft.toFields(confirmRemoveMirrors = true)
        assertEquals("bank", sent["institutionId"])
        assertEquals("-120.50", sent["openingBalance"])
        assertEquals("33.33", sent["share"])
        assertEquals("3", sent["noticeMonths"])
        assertEquals("5000", sent["freeWithdrawal"])
        assertEquals("year", sent["freeWithdrawalPeriod"])
        assertEquals("on", sent["fillFromTransfers"])
        assertEquals("on", sent["confirmRemoveMirrors"])
        assertFalse("tradesMoveCash" in sent)
        assertFalse("contractNumber" in sent)
        assertEquals("on", fields(draft.copy(type = "investment").toFields(hasPortfolios = false))["tradesMoveCash"])
        assertFalse("fillFromTransfers" in (draft.toFields(hasPortfolios = true)))
        assertEquals("on", fields(draft.copy(type = "current").toFields(hasTrades = true))["tradesMoveCash"])
    }

    private val savedAccount =
        AccountsAccount(
            id = "a",
            name = "Joint",
            type = "savings",
            currency = "CHF",
            iban = "ACCOUNT-1",
            openingBalance = -12_050,
            openingDate = "2026-01-02",
            noticeMonths = 6,
            freeWithdrawal = 2_500_000,
            freeWithdrawalPeriod = "month",
            shareBps = 3333,
            sharedWith = "Someone",
            fillFromTransfers = true,
        )

    @Test
    fun fillsTheEditFormFromTheAccount() {
        val draft = AccountDraft.from(savedAccount, "", "EUR")
        assertEquals("CHF", draft.currency)
        assertEquals("-120.50", draft.openingBalance)
        assertEquals("33.33", draft.share)
        assertEquals("25000.00", draft.freeWithdrawal)
        assertEquals("6", draft.noticeMonths)
        assertEquals("month", draft.freeWithdrawalPeriod)
        assertTrue(draft.fillFromTransfers)
        val fresh = AccountDraft.from(null, "bank", "EUR")
        assertEquals("EUR", fresh.currency)
        assertEquals("bank", fresh.institutionId)
        assertEquals("100", fresh.share)
        assertEquals("", fresh.openingBalance)
    }

    @Test
    fun asksBeforeTurningFillingOffUnlessThereIsNothingToDelete() {
        val draft = AccountDraft.from(savedAccount, "", "CHF")
        val off = draft.copy(fillFromTransfers = false)
        assertTrue(AccountDraft.needsMirrorConfirmation(savedAccount, off, hasPortfolios = false, mirrorCount = 3))
        assertTrue(AccountDraft.needsMirrorConfirmation(savedAccount, off, hasPortfolios = false, mirrorCount = null))
        assertFalse(AccountDraft.needsMirrorConfirmation(savedAccount, off, hasPortfolios = false, mirrorCount = 0))
        assertFalse(AccountDraft.needsMirrorConfirmation(savedAccount, draft, hasPortfolios = false, mirrorCount = 3))
        assertFalse(AccountDraft.needsMirrorConfirmation(null, off, hasPortfolios = false, mirrorCount = 3))
        assertFalse(AccountDraft.needsMirrorConfirmation(savedAccount.copy(fillFromTransfers = false), off, false, 3))
    }

    @Test
    fun movesTheSignOfATypedAmountIntoTheDirection() {
        val draft = TxDraft(outgoing = true)
        assertEquals("-12.50", draft.withAmountInput("12.50").signedAmount())
        val incoming = draft.withAmountInput("+12.50")
        assertFalse(incoming.outgoing)
        assertEquals("12.50", incoming.amount)
        assertEquals("12.50", incoming.signedAmount())
        val outgoing = incoming.withAmountInput("-3")
        assertTrue(outgoing.outgoing)
        assertEquals("-3", outgoing.signedAmount())
        assertEquals("", TxDraft().signedAmount())
    }

    @Test
    fun sendsAManualTransactionAndOnlyTheNoteOfAnImportedOne() {
        val draft =
            TxDraft(
                bookingDate = "2026-03-01",
                amount = "12.50",
                counterpartyName = "Example Shop",
                reference = "R1",
                note = "n",
            )
        val manual = (draft.toFields(null, noteOnly = false))
        assertEquals("-12.50", manual["amount"])
        assertEquals("2026-03-01", manual["bookingDate"])
        assertEquals("Example Shop", manual["counterpartyName"])
        assertFalse("transactionId" in manual)
        val imported = (draft.toFields("tx1", noteOnly = true))
        assertEquals(mapOf("transactionId" to "tx1", "note" to "n"), imported)
    }

    @Test
    fun fillsTheTransactionFormFromARow() {
        val tx = AccountDetailTx(id = "t", bookingDate = "2026-02-02", amount = -194_975, counterpartyName = "Supplier", note = "x")
        val draft = TxDraft.from(tx, "CHF", "2026-05-05")
        assertTrue(draft.outgoing)
        assertEquals("1949.75", draft.amount)
        assertEquals("2026-02-02", draft.bookingDate)
        val income = TxDraft.from(tx.copy(amount = 500), "CHF", "2026-05-05")
        assertFalse(income.outgoing)
        assertEquals("5.00", income.amount)
        assertEquals("2026-05-05", TxDraft.from(null, "CHF", "2026-05-05").bookingDate)
    }

    @Test
    fun offersTheAmountOfATradeUntilTheUserTypesOne() {
        assertEquals("1500.00", suggestAmount("buy", "1.5", "1000", "", "CHF", true))
        assertEquals("1505.00", suggestAmount("buy", "1.5", "1000", "5", "CHF", true))
        assertEquals("1495.00", suggestAmount("sell", "1.5", "1000", "5", "CHF", true))
        assertNull(suggestAmount("buy", "1.5", "1000", "", "CHF", false))
        assertNull(suggestAmount("buy", "", "1000", "", "CHF", true))
        assertNull(suggestAmount("buy", "1.5", "1000", "x", "CHF", true))
        assertNull(suggestAmount("sell", "1", "5", "10", "CHF", true))
        val draft = TradeDraft(side = "buy", quantity = "2", price = "10.5")
        assertEquals("21.00", draft.withSuggestedAmount("CHF", true).amount)
        assertEquals("", draft.copy(amountTouched = true).withSuggestedAmount("CHF", true).amount)
        assertEquals("", draft.withSuggestedAmount("CHF", false).amount)
        assertEquals("", draft.copy(side = "split").withSuggestedAmount("CHF", true).amount)
    }

    @Test
    fun sendsTheFieldsOfATradeBySide() {
        val buy =
            fields(
                TradeDraft(
                    securityId = "s",
                    date = "2026-01-01",
                    side = "buy",
                    quantity = "1.5",
                    price = "10",
                    fees = "1",
                    amount = "16",
                    note = "n",
                ).toFields(null),
            )
        assertEquals("1.5", buy["quantity"])
        assertEquals("16", buy["amount"])
        assertFalse("splitNew" in buy)
        assertFalse("tradeId" in buy)
        val split =
            fields(
                TradeDraft(
                    securityId = "s",
                    date = "2026-01-01",
                    side = "split",
                    splitNew = "2",
                    splitOld = "1",
                    quantity = "9",
                ).toFields("t1"),
            )
        assertEquals("2", split["splitNew"])
        assertEquals("1", split["splitOld"])
        assertEquals("t1", split["tradeId"])
        assertFalse("quantity" in split)
        assertFalse("price" in split)
    }

    @Test
    fun fillsTheTradeFormFromATrade() {
        val buy =
            AccountDetailTrade(
                id = "t",
                securityId = "s",
                date = "2026-01-01",
                side = "buy",
                quantity = 150_000_000,
                price = 1_050_000_000,
                fees = 100,
                amount = 1_606,
                note = "n",
            )
        val draft = TradeDraft.from(buy, "CHF", "other", "2026-05-05")
        assertEquals("s", draft.securityId)
        assertEquals("1.5", draft.quantity)
        assertEquals("10.5", draft.price)
        assertEquals("1.00", draft.fees)
        assertEquals("16.06", draft.amount)
        assertTrue(draft.amountTouched)
        val split = AccountDetailTrade(id = "u", side = "split", quantity = 200_000_000)
        val splitDraft = TradeDraft.from(split, "CHF", "s", "2026-05-05")
        assertEquals("2", splitDraft.splitNew)
        assertEquals("1", splitDraft.splitOld)
        val fresh = TradeDraft.from(null, "CHF", "first", "2026-05-05")
        assertEquals("first", fresh.securityId)
        assertEquals("2026-05-05", fresh.date)
        assertFalse(fresh.amountTouched)
    }

    @Test
    fun sendsPortfolioValuesPerPortfolio() {
        val portfolios =
            listOf(AccountDetailPortfolio(id = "p1", name = "One", latestValue = 123_456), AccountDetailPortfolio(id = "p2", name = "Two"))
        val draft = PortfolioValuesDraft.from(portfolios, "CHF", "2026-06-01")
        assertEquals("1234.56", draft.values["p1"])
        assertEquals("", draft.values["p2"])
        val sent = fields(draft.copy(note = "n", values = draft.values + ("p2" to "10")).toFields())
        assertEquals("2026-06-01", sent["date"])
        assertEquals("1234.56", sent["value:p1"])
        assertEquals("10", sent["value:p2"])
        assertEquals("n", sent["note"])
    }

    @Test
    fun spacesTheReferenceOfAPortfolioInTheForm() {
        val portfolio = AccountDetailPortfolio(id = "p", name = "One", depositReference = "210000000003139471430009017", sortOrder = 2)
        val draft = PortfolioDraft.from(portfolio)
        assertEquals("21 00000 00003 13947 14300 09017", draft.depositReference)
        assertEquals("2", draft.sortOrder)
        assertEquals("p", (draft.toFields("p"))["portfolioId"])
        assertEquals("", PortfolioDraft.from(portfolio.copy(sortOrder = 0)).sortOrder)
    }

    @Test
    fun asksTheServerOnlyForWhatIsFiltered() {
        assertEquals(emptyMap(), TxQuery().toParams())
        val query = TxQuery(from = "2026-01-01", q = " shop ", min = "-100", page = 3)
        assertEquals(mapOf("from" to "2026-01-01", "q" to "shop", "min" to "-100", "page" to "3"), query.toParams())
        assertTrue(query.hasFilters)
        assertFalse(TxQuery(page = 2).hasFilters)
    }

    @Test
    fun ordersCategoriesParentsFirst() {
        fun category(
            id: String,
            name: String,
            parent: String? = null,
        ) = AccountDetailCategory(id = id, name = name, parentId = parent)
        val all =
            listOf(
                category("g", "Groceries", "food"),
                category("t", "Travel"),
                category("food", "Food"),
                category("r", "Restaurants", "food"),
                category("o", "Orphan", "gone"),
            )
        assertEquals(listOf("food", "g", "r", "o", "t"), orderedCategories(all).map { it.id })
        assertEquals(listOf("g"), filterCategories(orderedCategories(all), all, "grocer").map { it.id })
        assertEquals(listOf("g", "r"), filterCategories(orderedCategories(all), all, "FOOD /").map { it.id })
        assertEquals(5, filterCategories(orderedCategories(all), all, " ").size)
    }
}
