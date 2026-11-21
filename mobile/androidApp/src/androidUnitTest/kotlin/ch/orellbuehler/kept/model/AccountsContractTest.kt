package ch.orellbuehler.kept.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AccountsContractTest {
    @Test
    fun decodesTheAccountList() {
        val page = Contract.page<AccountsPage>("accounts")
        assertTrue(page.institutions.isNotEmpty())
        assertTrue(page.institutions.all { it.id.isNotEmpty() && it.accountCount >= 0 })
        assertNotNull(page.institutions.first().bic)
        assertNull(page.institutions.last().bic)
        assertTrue(page.accounts.size >= 6)
        assertTrue(page.accounts.all { it.id.isNotEmpty() && it.currency.length == 3 })
        assertTrue(page.accounts.any { it.type == "investment" && it.holdings != null })
        assertTrue(page.accounts.any { it.type == "pillar_3a" && it.contractNumber != null && it.depositIban != null })
        val savings = page.accounts.first { it.type == "savings" }
        assertEquals("year", savings.freeWithdrawalPeriod)
        assertNotNull(savings.freeWithdrawal)
        assertNotNull(savings.noticeMonths)
        assertTrue(page.accounts.any { it.institution != null })
    }

    @Test
    fun decodesTheCheckingAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.checking")
        assertEquals("current", page.account.type)
        assertEquals(page.account.balance, page.balance)
        assertNull(page.value)
        assertEquals(25, page.transactions.items.size)
        assertEquals(54, page.transactions.total)
        assertEquals(3, page.transactions.pageCount)
        assertTrue(page.transactions.items.all { it.id.isNotEmpty() && it.bookingDate.length == 10 })
        assertTrue(page.transactions.items.any { it.counterpartyIban != null && it.reference != null })
        assertTrue(page.transactions.items.any { it.categoryId != null && it.note != null })
        assertTrue(page.transactions.items.any { it.transfer != null })
        assertTrue(page.categories.isNotEmpty())
        assertTrue(page.categories.any { it.parentId != null })
        assertTrue(page.institutions.isNotEmpty())
        assertEquals(2, page.snapshots.size)
        assertEquals("", page.filters.q)
        assertTrue(page.filterErrors.isEmpty())
        assertEquals(1, page.transactionLinks.size)
        assertTrue(
            page.transactionLinks.values
                .first()
                .first()
                .url
                .startsWith("https://"),
        )
    }

    @Test
    fun decodesTheFilteredCaptures() {
        val tax = Contract.page<AccountDetailPage>("accounts.id.checking.tax")
        assertEquals("Example Tax Office", tax.filters.q)
        assertEquals(5, tax.transactions.total)
        assertTrue(tax.transactions.items.any { it.taxYear != null })
        val donations = Contract.page<AccountDetailPage>("accounts.id.checking.donations")
        assertEquals("Example Charity", donations.filters.q)
        assertEquals(3, donations.transactions.items.size)
        assertTrue(donations.transactions.items.any { it.deductionYear != null })
    }

    @Test
    fun decodesTheSavingsAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.savings")
        assertEquals("savings", page.account.type)
        assertEquals(3, page.account.noticeMonths)
        assertEquals("year", page.account.freeWithdrawalPeriod)
        assertTrue(page.account.fillFromTransfers)
        assertTrue(page.transactions.items.any { it.source == "mirror" && it.mirrorOf != null })
        assertTrue(page.transfers.mirrorCount > 0)
    }

    @Test
    fun decodesTheCreditCard() {
        val page = Contract.page<AccountDetailPage>("accounts.id.credit-card")
        assertEquals("credit_card", page.account.type)
        assertNull(page.account.iban)
        assertEquals(8, page.transactions.items.size)
    }

    @Test
    fun decodesTheInvestmentAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.investment")
        assertEquals("investment", page.account.type)
        assertTrue(page.hasHoldings)
        assertTrue(page.account.tradesMoveCash)
        val value = assertNotNull(page.value)
        assertEquals(page.balance, value.total)
        assertTrue(value.positions.isNotEmpty())
        assertTrue(value.positions.all { it.quantity > 0 && it.price > 0 && it.currency.isNotEmpty() })
        assertEquals(5, page.trades.size)
        assertTrue(page.trades.any { it.side == "sell" })
        assertTrue(page.trades.any { it.side == "split" && it.splitNew != null && it.splitOld != null })
        assertTrue(page.securities.isNotEmpty())
    }

    @Test
    fun decodesThePillar3aAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.pillar3a")
        assertEquals("pillar_3a", page.account.type)
        assertTrue(page.showPortfolios)
        assertEquals(2, page.portfolios.size)
        assertTrue(page.portfolios.all { it.id.isNotEmpty() && it.name.isNotEmpty() })
        assertTrue(page.portfolios.any { it.depositReference != null })
        assertTrue(page.portfolios.any { it.latestValue != null && it.latestValueDate != null })
        assertEquals(page.portfolios.map { it.id }.toSet(), page.portfolioValues.keys)
        assertTrue(
            page.portfolioValues.values
                .flatten()
                .all { it.date.length == 10 },
        )
        assertNotNull(page.value).also { assertTrue(it.portfolios > 0) }
    }

    @Test
    fun decodesThePensionAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.pension")
        assertEquals("pension", page.account.type)
        assertEquals(1, page.snapshots.size)
        assertEquals(0, page.transactions.total)
        assertEquals(1, page.transfers.fillSuggestion?.count)
        assertTrue(page.snapshots.all { it.source == "manual" || it.source == "import" })
    }

    @Test
    fun decodesTheEuroAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.euro")
        assertEquals("EUR", page.account.currency)
        val needs = page.transfers.needsAmount
        assertEquals(1, needs.size)
        assertTrue(needs.first().transferId.isNotEmpty())
        assertEquals("EUR", needs.first().targetCurrency)
        assertNotNull(needs.first().linkCandidate)
        assertEquals("in", needs.first().direction)
    }

    @Test
    fun decodesTheJointAccount() {
        val page = Contract.page<AccountDetailPage>("accounts.id.joint")
        assertEquals(5000, page.account.shareBps)
        assertNotNull(page.account.sharedWith)
        assertEquals(2, page.transactions.items.size)
    }

    @Test
    fun decodesTheImportHistory() {
        val page = Contract.page<AccountImportsPage>("accounts.id.imports")
        assertEquals("current", page.account.type)
        assertEquals(2, page.imports.size)
        assertTrue(page.imports.all { it.id.isNotEmpty() && it.fileName.isNotEmpty() && it.format.isNotEmpty() })
        assertTrue(page.imports.any { it.warnings.isNotEmpty() })
        assertEquals(page.imports.map { it.id }.toSet(), page.impacts.keys)
        assertTrue(page.imports.all { it.statementFrom != null && it.openingBalance != null })
        assertTrue(page.impacts.values.any { it.categorized > 0 })
    }

    @Test
    fun decodesTheResultsOfTheActionsThatAnswerData() {
        val candidates =
            ApiJson.decodeFromString<AccountDetailCandidates>(
                """{"success":true,"action":"transferCandidates","transactionId":"t","candidates":[
                {"id":"c","accountId":"a","accountName":"Example Savings","bookingDate":"2026-03-01","amount":20000,"currency":"CHF",
                "counterpartyName":null,"description":"Top up","exact":true,"days":0}]}""",
            )
        assertEquals("t", candidates.transactionId)
        assertEquals(1, candidates.candidates.size)
        assertTrue(candidates.candidates.first().exact)
        assertNull(candidates.candidates.first().counterpartyName)
        val filled =
            ApiJson.decodeFromString<AccountDetailFillResult>(
                """{"success":true,"action":"enableFillFromTransfers","paired":1,"mirrored":2,"needsAmount":0}""",
            )
        assertEquals(1, filled.paired)
        assertEquals(2, filled.mirrored)
    }
}
