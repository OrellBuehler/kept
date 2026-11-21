package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/**
 * `GET pages/accounts/<id>`. Quantities and prices of trades and positions are integers scaled by
 * 10^8 (1.5 units is 150000000), amounts are minor units of the account's currency.
 */
@Serializable
data class AccountDetailPage(
    val account: AccountsAccount,
    val balance: Long = 0,
    /** Cash, holdings and portfolios; null where the account has neither holdings nor portfolios. */
    val value: AccountDetailValue? = null,
    val hasHoldings: Boolean = false,
    val showPortfolios: Boolean = false,
    val portfolios: List<AccountDetailPortfolio> = emptyList(),
    /** Value history per portfolio id, newest first. */
    val portfolioValues: Map<String, List<AccountDetailPortfolioValue>> = emptyMap(),
    val trades: List<AccountDetailTrade> = emptyList(),
    val securities: List<AccountDetailSecurity> = emptyList(),
    val institutions: List<AccountDetailInstitution> = emptyList(),
    val transactions: AccountDetailTransactions = AccountDetailTransactions(),
    val snapshots: List<AccountDetailSnapshot> = emptyList(),
    val transfers: AccountDetailTransfers = AccountDetailTransfers(),
    val categories: List<AccountDetailCategory> = emptyList(),
    val filters: AccountDetailFilters = AccountDetailFilters(),
    val filterErrors: Map<String, List<String>> = emptyMap(),
    val transactionLinks: Map<String, List<AccountDetailLink>> = emptyMap(),
)

@Serializable
data class AccountDetailValue(
    val cash: Long = 0,
    val holdings: Long = 0,
    val portfolios: Long = 0,
    val total: Long = 0,
    val positions: List<AccountDetailPosition> = emptyList(),
    val estimated: Boolean = false,
)

@Serializable
data class AccountDetailPosition(
    val securityId: String,
    val name: String = "",
    val currency: String = "",
    val quantity: Long = 0,
    val price: Long = 0,
    val priceDate: String? = null,
    /** "manual", "provider", or "trade" (the last trade price). */
    val priceSource: String = "manual",
    val value: Long = 0,
    val cost: Long = 0,
    val gain: Long = 0,
    val estimated: Boolean = false,
)

@Serializable
data class AccountDetailTrade(
    val id: String,
    val securityId: String = "",
    val securityName: String = "",
    val securityCurrency: String = "",
    val date: String = "",
    /** "buy", "sell" or "split". */
    val side: String = "buy",
    val quantity: Long = 0,
    val splitNew: Long? = null,
    val splitOld: Long? = null,
    val price: Long = 0,
    val fees: Long = 0,
    val amount: Long = 0,
    val note: String? = null,
)

@Serializable
data class AccountDetailSecurity(
    val id: String,
    val name: String = "",
    val currency: String = "",
    val kind: String = "other",
    val isin: String? = null,
    val symbol: String? = null,
)

@Serializable
data class AccountDetailInstitution(
    val id: String,
    val name: String = "",
)

@Serializable
data class AccountDetailTransactions(
    val items: List<AccountDetailTx> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 50,
    val pageCount: Int = 1,
)

@Serializable
data class AccountDetailTx(
    val id: String,
    /** "manual", "import" or "mirror". */
    val source: String = "manual",
    val bookingDate: String = "",
    val valueDate: String? = null,
    val amount: Long = 0,
    val currency: String = "",
    val originalAmount: Long? = null,
    val originalCurrency: String? = null,
    val counterpartyName: String? = null,
    val counterpartyIban: String? = null,
    val description: String? = null,
    val reference: String? = null,
    val referenceType: String? = null,
    val reversal: Boolean = false,
    val note: String? = null,
    val categoryId: String? = null,
    val taxYear: Int? = null,
    val deductionYear: Int? = null,
    val mirrorOf: AccountDetailMirrorOf? = null,
    val transfer: AccountDetailTransfer? = null,
)

@Serializable
data class AccountDetailMirrorOf(
    val accountId: String = "",
    val accountName: String = "",
    val transactionId: String = "",
    val noBankCounterpart: Boolean = false,
)

@Serializable
data class AccountDetailTransfer(
    val id: String,
    /** "linked", "needs_amount" or "dismissed". */
    val status: String = "linked",
    /** "paired", "mirrored" or "manual". */
    val method: String = "paired",
    /** "out" when this account paid. */
    val direction: String = "out",
    val peerAccountId: String = "",
    val peerAccountName: String = "",
    val peerTransactionId: String? = null,
)

@Serializable
data class AccountDetailLink(
    val id: String,
    val label: String = "",
    val url: String = "",
    val source: String = "",
)

@Serializable
data class AccountDetailSnapshot(
    val id: String,
    val date: String = "",
    val amount: Long = 0,
    /** "manual" or "import". */
    val source: String = "manual",
    val note: String? = null,
)

@Serializable
data class AccountDetailTransfers(
    /** Mirrored transactions on this account (for the confirmation when filling is turned off). */
    val mirrorCount: Int = 0,
    /** A never-imported account that is not filled yet: how many transfers other accounts show to its IBAN. */
    val fillSuggestion: AccountDetailFillSuggestion? = null,
    val needsAmount: List<AccountDetailNeedsAmount> = emptyList(),
)

@Serializable
data class AccountDetailFillSuggestion(
    val count: Int = 0,
)

/** A transfer in another currency that waits for the amount this account booked. */
@Serializable
data class AccountDetailNeedsAmount(
    val transferId: String,
    val sourceAccountId: String = "",
    val sourceAccountName: String = "",
    val targetCurrency: String = "",
    /** "in" when money arrives on this account. */
    val direction: String = "in",
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val description: String? = null,
    val linkCandidate: AccountDetailLinkCandidate? = null,
)

@Serializable
data class AccountDetailLinkCandidate(
    val id: String,
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val description: String? = null,
)

@Serializable
data class AccountDetailCategory(
    val id: String,
    val name: String = "",
    val parentId: String? = null,
    /** "expense" or "income". */
    val kind: String = "expense",
    val color: String? = null,
    val icon: String? = null,
)

/** The filters as typed, to fill the filter form again. */
@Serializable
data class AccountDetailFilters(
    val from: String = "",
    val to: String = "",
    val q: String = "",
    val min: String = "",
    val max: String = "",
)

@Serializable
data class AccountDetailPortfolio(
    val id: String,
    val name: String = "",
    val number: String? = null,
    val strategy: String? = null,
    val depositReference: String? = null,
    val openedOn: String? = null,
    val closedOn: String? = null,
    val closeReason: String? = null,
    val sortOrder: Int = 0,
    val latestValue: Long? = null,
    val latestValueDate: String? = null,
)

@Serializable
data class AccountDetailPortfolioValue(
    val id: String,
    val portfolioId: String = "",
    val date: String = "",
    val amount: Long = 0,
    val note: String? = null,
)

/** The result of the `transferCandidates` action: rows of other accounts that could be the other side. */
@Serializable
data class AccountDetailCandidates(
    val transactionId: String = "",
    val candidates: List<AccountDetailCandidate> = emptyList(),
)

@Serializable
data class AccountDetailCandidate(
    val id: String,
    val accountName: String = "",
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val counterpartyName: String? = null,
    val description: String? = null,
    /** The amount equals the transaction's. */
    val exact: Boolean = false,
    val days: Int = 0,
)

/** The result of `enableFillFromTransfers`. */
@Serializable
data class AccountDetailFillResult(
    val paired: Int = 0,
    val mirrored: Int = 0,
    val needsAmount: Int = 0,
)
