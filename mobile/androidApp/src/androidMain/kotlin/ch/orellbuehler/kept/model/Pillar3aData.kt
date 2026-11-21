package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/pillar-3a`. All amounts are CHF minor units. */
@Serializable
data class Pillar3aPage(
    val today: String = "",
    val overview: Pillar3aOverview = Pillar3aOverview(),
    val contributions: List<Pillar3aContribution> = emptyList(),
    /** The user's pillar 3a accounts. */
    val accounts: List<Pillar3aAccount> = emptyList(),
)

@Serializable
data class Pillar3aAccount(
    val id: String,
    val name: String = "",
    val archived: Boolean = false,
)

@Serializable
data class Pillar3aOverview(
    val years: List<Pillar3aYear> = emptyList(),
    val gaps: List<Pillar3aGap> = emptyList(),
    val portfolios: List<Pillar3aPortfolio> = emptyList(),
    val totals: Pillar3aTotals = Pillar3aTotals(),
    val ageBenefitDrawn: Boolean = false,
    val orphanAnnotations: List<Pillar3aOrphan> = emptyList(),
)

@Serializable
data class Pillar3aYear(
    val year: Int,
    /** "small", "large" or "none". */
    val deduction: String = "small",
    val earnedIncome: Long? = null,
    val settingInherited: Boolean = false,
    val limit: Long = 0,
    val limitUnconfirmed: Boolean = false,
    val ordinary: Long = 0,
    val buyIn: Long = 0,
    val gap: Long = 0,
    val overLimit: Long = 0,
    /** Contribution id of the buy-in that closed this gap year. */
    val closedBy: String? = null,
    val buyInEligible: Boolean = false,
)

/** A year with room left that a buy-in may close. */
@Serializable
data class Pillar3aGap(
    val year: Int,
    val limit: Long = 0,
    val unconfirmed: Boolean = false,
    val ordinary: Long = 0,
    val gap: Long = 0,
    val closedBy: String? = null,
)

@Serializable
data class Pillar3aPortfolio(
    val portfolioId: String,
    val accountId: String = "",
    val accountName: String = "",
    val archived: Boolean = false,
    val name: String = "",
    val strategy: String? = null,
    val depositReference: String? = null,
    val closedOn: String? = null,
    val closeReason: String? = null,
    val latestValue: Long? = null,
    val latestValueDate: String? = null,
    val contributed: Long = 0,
    val gain: Long? = null,
)

@Serializable
data class Pillar3aTotals(
    val value: Long = 0,
    val contributed: Long = 0,
    val gain: Long = 0,
)

/** An annotation of a payment that is no longer detected as a contribution. */
@Serializable
data class Pillar3aOrphan(
    val id: String,
    val portfolioName: String = "",
    val date: String = "",
    val kind: String = "ordinary",
    val gapYears: List<Int> = emptyList(),
    val note: String? = null,
)

/** One contribution: a detected payment (maybe annotated) or a manual entry. */
@Serializable
data class Pillar3aContribution(
    val key: String,
    /** The contribution row; null for a plain detected payment. */
    val id: String? = null,
    val transactionId: String? = null,
    /** "detected" or "manual". */
    val source: String = "detected",
    val portfolioId: String = "",
    val portfolioName: String = "",
    val accountId: String = "",
    val bookingDate: String? = null,
    /** The credit date: it sets the tax year. */
    val date: String = "",
    val year: Int = 0,
    val amount: Long = 0,
    /** "ordinary" or "buy_in". */
    val kind: String = "ordinary",
    val gapYears: List<Int> = emptyList(),
    val note: String? = null,
    val dateOverridden: Boolean = false,
    val lateDecemberWarning: String? = null,
) {
    val isDetected: Boolean get() = source == "detected"
    val isBuyIn: Boolean get() = kind == "buy_in"
}

/** What `GET endpoints/pillar-3a/buy-in-check` answers. */
@Serializable
data class Pillar3aBuyInCheck(
    val errors: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
)

/** What `addContribution` and `updateContribution` answer: rule warnings worth showing after a save. */
@Serializable
data class Pillar3aSaveResult(
    val warnings: List<String> = emptyList(),
)
