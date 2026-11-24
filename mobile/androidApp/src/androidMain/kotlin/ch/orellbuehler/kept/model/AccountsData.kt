package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** `GET pages/accounts`. Amounts are minor units of the account's currency. */
@Serializable
data class AccountsPage(
    val institutions: List<AccountsInstitution> = emptyList(),
    val accounts: List<AccountsAccount> = emptyList(),
)

@Serializable
data class AccountsInstitution(
    val id: String,
    val name: String = "",
    val bic: String? = null,
    val color: String? = null,
    val logoVersion: String? = null,
    val websiteUrl: String? = null,
    val accountCount: Int = 0,
)

/** An account as the list and the detail page describe it. */
@Serializable
data class AccountsAccount(
    val id: String,
    val name: String = "",
    val type: String = "other",
    val currency: String = "",
    val iban: String? = null,
    val contractNumber: String? = null,
    val websiteUrl: String? = null,
    /** Pillar 3a: the QR-IBAN payments go to; any other type: the IBAN the account is topped up through. */
    val depositIban: String? = null,
    val openingBalance: Long = 0,
    val openingDate: String? = null,
    val noticeMonths: Int? = null,
    val freeWithdrawal: Long? = null,
    val freeWithdrawalPeriod: String? = null,
    val fillFromTransfers: Boolean = false,
    val tradesMoveCash: Boolean = false,
    val archived: Boolean = false,
    val sortOrder: Int = 0,
    val shareBps: Int = 10_000,
    val sharedWith: String? = null,
    val institution: InstitutionRef? = null,
    val balance: Long = 0,
    val cashBalance: Long = 0,
    val holdings: AccountsHoldingsSummary? = null,
    val shareBalance: Long = 0,
    val lastBookingDate: String? = null,
    val lastImportAt: Long? = null,
    /** When the user last confirmed there is nothing new to import. */
    val lastCheckedAt: Long? = null,
)

@Serializable
data class AccountsHoldingsSummary(
    val value: Long = 0,
    val cost: Long = 0,
    val estimated: Boolean = false,
)
