package ch.orellbuehler.kept.ui.accounts

import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.model.AccountDetailPortfolio
import ch.orellbuehler.kept.model.AccountDetailTrade
import ch.orellbuehler.kept.model.AccountDetailTx
import ch.orellbuehler.kept.model.AccountsAccount
import ch.orellbuehler.kept.model.AccountsInstitution
import kotlin.math.abs

/** An institution as the form edits it (the logo is left to the browser). */
data class InstitutionDraft(
    val name: String = "",
    val bic: String = "",
    val color: String = "",
) {
    fun toFields(id: String?): Map<String, String> =
        fields {
            if (id != null) set("id", id)
            set("name", name)
            set("bic", bic)
            set("color", color)
        }

    fun toForm(id: String?): FormBody = toFields(id).toFormBody()

    companion object {
        fun from(institution: AccountsInstitution?) =
            InstitutionDraft(institution?.name.orEmpty(), institution?.bic.orEmpty(), institution?.color.orEmpty())
    }
}

/** The fields of the account form; amounts and the share are typed text the server parses. */
data class AccountDraft(
    val name: String = "",
    val institutionId: String = "",
    val type: String = "current",
    val currency: String = "",
    val iban: String = "",
    val contractNumber: String = "",
    val depositIban: String = "",
    val openingBalance: String = "",
    val openingDate: String = "",
    val share: String = "100",
    val sharedWith: String = "",
    val noticeMonths: String = "",
    val freeWithdrawal: String = "",
    val freeWithdrawalPeriod: String = "",
    val fillFromTransfers: Boolean = false,
    val tradesMoveCash: Boolean = false,
) {
    val is3a: Boolean get() = type == "pillar_3a"
    val hasNotice: Boolean get() = type in NOTICE_ACCOUNT_TYPES

    /** Pillar 3a accounts and accounts with portfolios cannot be filled from transfers. */
    fun showFill(hasPortfolios: Boolean): Boolean = !is3a && !hasPortfolios

    /** Investment accounts, and accounts that have trades, can make trades move cash. */
    fun showTradesCash(hasTrades: Boolean): Boolean = type == "investment" || hasTrades

    /** Same fields, same conditions as the web form, so the server parses exactly what a browser would send. */
    fun toFields(
        hasPortfolios: Boolean = false,
        hasTrades: Boolean = false,
        confirmRemoveMirrors: Boolean = false,
    ): Map<String, String> =
        fields {
            set("institutionId", institutionId)
            set("type", type)
            set("fillFromTransfersField", "1")
            check("confirmRemoveMirrors", confirmRemoveMirrors)
            set("name", name)
            set("currency", currency)
            set("iban", iban)
            if (is3a) {
                set("contractNumber", contractNumber)
                set("depositIban", depositIban)
            }
            set("openingBalance", openingBalance)
            set("openingDate", openingDate)
            if (!is3a) {
                set("share", share)
                set("sharedWith", sharedWith)
            }
            if (hasNotice) {
                set("noticeMonths", noticeMonths)
                set("freeWithdrawal", freeWithdrawal)
                set("freeWithdrawalPeriod", freeWithdrawalPeriod)
            }
            check("fillFromTransfers", showFill(hasPortfolios) && fillFromTransfers)
            check("tradesMoveCash", showTradesCash(hasTrades) && tradesMoveCash)
        }

    fun toForm(
        hasPortfolios: Boolean = false,
        hasTrades: Boolean = false,
        confirmRemoveMirrors: Boolean = false,
    ): FormBody = toFields(hasPortfolios, hasTrades, confirmRemoveMirrors).toFormBody()

    companion object {
        fun from(
            account: AccountsAccount?,
            defaultInstitutionId: String,
            defaultCurrency: String,
        ): AccountDraft =
            if (account == null) {
                AccountDraft(institutionId = defaultInstitutionId, currency = defaultCurrency)
            } else {
                AccountDraft(
                    name = account.name,
                    institutionId = account.institution?.id.orEmpty(),
                    type = account.type,
                    currency = account.currency,
                    iban = account.iban.orEmpty(),
                    contractNumber = account.contractNumber.orEmpty(),
                    depositIban = account.depositIban.orEmpty(),
                    openingBalance = if (account.openingBalance != 0L) Amounts.toInput(account.openingBalance, account.currency) else "",
                    openingDate = account.openingDate.orEmpty(),
                    share = shareToInput(account.shareBps),
                    sharedWith = account.sharedWith.orEmpty(),
                    noticeMonths = account.noticeMonths?.toString().orEmpty(),
                    freeWithdrawal = account.freeWithdrawal?.let { Amounts.toInput(it, account.currency) }.orEmpty(),
                    freeWithdrawalPeriod = account.freeWithdrawalPeriod.orEmpty(),
                    fillFromTransfers = account.fillFromTransfers,
                    tradesMoveCash = account.tradesMoveCash,
                )
            }

        /** Turning "fill from transfers" off deletes the mirrors: the web asks first, so does the app. */
        fun needsMirrorConfirmation(
            account: AccountsAccount?,
            draft: AccountDraft,
            hasPortfolios: Boolean,
            mirrorCount: Int?,
        ): Boolean =
            account != null &&
                account.fillFromTransfers &&
                !(draft.showFill(hasPortfolios) && draft.fillFromTransfers) &&
                mirrorCount != 0
    }
}

/** A manual transaction as the form edits it. The amount is typed without sign; [outgoing] says which way it goes. */
data class TxDraft(
    val bookingDate: String = "",
    val valueDate: String = "",
    val outgoing: Boolean = true,
    val amount: String = "",
    val counterpartyName: String = "",
    val counterpartyIban: String = "",
    val description: String = "",
    val reference: String = "",
    val note: String = "",
) {
    /** What the form's hidden `amount` field carries: the typed amount with a minus sign when it goes out. */
    fun signedAmount(): String = if (amount.isBlank()) "" else (if (outgoing) "-" else "") + amount.trim()

    /** A leading "-" or "+" the user types switches the direction and is not kept in the field. */
    fun withAmountInput(raw: String): TxDraft {
        val trimmed = raw.trimStart()
        return when {
            trimmed.startsWith("-") -> copy(outgoing = true, amount = trimmed.drop(1))
            trimmed.startsWith("+") -> copy(outgoing = false, amount = trimmed.drop(1))
            else -> copy(amount = trimmed)
        }
    }

    /** Imported rows and mirrors only take a note. */
    fun toFields(
        transactionId: String?,
        noteOnly: Boolean,
    ): Map<String, String> =
        fields {
            if (transactionId != null) set("transactionId", transactionId)
            if (!noteOnly) {
                set("bookingDate", bookingDate)
                set("valueDate", valueDate)
                set("amount", signedAmount())
                set("counterpartyName", counterpartyName)
                set("counterpartyIban", counterpartyIban)
                set("description", description)
                set("reference", reference)
            }
            set("note", note)
        }

    fun toForm(
        transactionId: String?,
        noteOnly: Boolean,
    ): FormBody = toFields(transactionId, noteOnly).toFormBody()

    companion object {
        fun from(
            tx: AccountDetailTx?,
            currency: String,
            today: String,
        ): TxDraft =
            if (tx == null) {
                TxDraft(bookingDate = today)
            } else {
                TxDraft(
                    bookingDate = tx.bookingDate,
                    valueDate = tx.valueDate.orEmpty(),
                    outgoing = tx.amount <= 0,
                    amount = Amounts.toInput(abs(tx.amount), currency),
                    counterpartyName = tx.counterpartyName.orEmpty(),
                    counterpartyIban = tx.counterpartyIban.orEmpty(),
                    description = tx.description.orEmpty(),
                    reference = tx.reference.orEmpty(),
                    note = tx.note.orEmpty(),
                )
            }
    }
}

/** A balance snapshot. */
data class SnapshotDraft(
    val date: String = "",
    val amount: String = "",
    val note: String = "",
) {
    fun toFields(): Map<String, String> =
        fields {
            set("date", date)
            set("amount", amount)
            set("note", note)
        }

    fun toForm(): FormBody = toFields().toFormBody()
}

/** A trade (buy, sell or split) as the form edits it; quantity and price are decimal text, the server scales them. */
data class TradeDraft(
    val securityId: String = "",
    val date: String = "",
    val side: String = "buy",
    val quantity: String = "",
    val splitNew: String = "",
    val splitOld: String = "",
    val price: String = "",
    val fees: String = "",
    val amount: String = "",
    val note: String = "",
    /** The amount follows quantity, price and fees until the user types one. */
    val amountTouched: Boolean = false,
) {
    val isSplit: Boolean get() = side == "split"

    fun toFields(tradeId: String?): Map<String, String> =
        fields {
            if (tradeId != null) set("tradeId", tradeId)
            set("securityId", securityId)
            set("side", side)
            set("date", date)
            if (isSplit) {
                set("splitNew", splitNew)
                set("splitOld", splitOld)
            } else {
                set("quantity", quantity)
                set("price", price)
                set("fees", fees)
                set("amount", amount)
            }
            set("note", note)
        }

    fun toForm(tradeId: String?): FormBody = toFields(tradeId).toFormBody()

    /** The amount offered while it is untouched: quantity times price, plus fees for a buy and minus for a sell. */
    fun withSuggestedAmount(
        currency: String,
        sameCurrency: Boolean,
    ): TradeDraft {
        if (amountTouched || isSplit) return this
        val suggestion = suggestAmount(side, quantity, price, fees, currency, sameCurrency) ?: return this
        return copy(amount = suggestion)
    }

    companion object {
        fun from(
            trade: AccountDetailTrade?,
            currency: String,
            firstSecurityId: String,
            today: String,
        ): TradeDraft {
            if (trade == null) return TradeDraft(securityId = firstSecurityId, date = today)
            val terms = if (trade.side == "split") Fixed8.splitTerms(trade) else null
            return TradeDraft(
                securityId = trade.securityId,
                date = trade.date,
                side = trade.side,
                quantity = Fixed8.toInput(trade.quantity),
                splitNew = terms?.first?.toString().orEmpty(),
                splitOld = terms?.second?.toString().orEmpty(),
                price = Fixed8.toInput(trade.price),
                fees = if (trade.fees != 0L) Amounts.toInput(trade.fees, currency) else "",
                amount = Amounts.toInput(trade.amount, currency),
                note = trade.note.orEmpty(),
                amountTouched = true,
            )
        }
    }
}

/**
 * Cash paid or received for a trade, as a form value, when it can be worked out: only without an
 * exchange rate in between. Null when an input is not a number or the total is not positive.
 */
fun suggestAmount(
    side: String,
    quantity: String,
    price: String,
    fees: String,
    currency: String,
    sameCurrency: Boolean,
): String? {
    if (!sameCurrency) return null
    val q = Fixed8.parse(quantity) ?: return null
    val p = Fixed8.parse(price) ?: return null
    val gross = Fixed8.valueOf(q, p, Fixed8.SCALE, currency)
    val fee = if (fees.isBlank()) 0L else Amounts.parse(fees, currency) ?: return null
    val total = if (side == "buy") gross + fee else gross - fee
    return if (total > 0) Amounts.toInput(total, currency) else null
}

data class PortfolioDraft(
    val name: String = "",
    val strategy: String = "",
    val number: String = "",
    val depositReference: String = "",
    val openedOn: String = "",
    val sortOrder: String = "",
) {
    fun toFields(portfolioId: String?): Map<String, String> =
        fields {
            if (portfolioId != null) set("portfolioId", portfolioId)
            set("name", name)
            set("strategy", strategy)
            set("number", number)
            set("depositReference", depositReference)
            set("openedOn", openedOn)
            set("sortOrder", sortOrder)
        }

    fun toForm(portfolioId: String?): FormBody = toFields(portfolioId).toFormBody()

    companion object {
        fun from(portfolio: AccountDetailPortfolio?): PortfolioDraft =
            if (portfolio == null) {
                PortfolioDraft()
            } else {
                PortfolioDraft(
                    name = portfolio.name,
                    strategy = portfolio.strategy.orEmpty(),
                    number = portfolio.number.orEmpty(),
                    depositReference = portfolio.depositReference?.let { formatReference(it) }.orEmpty(),
                    openedOn = portfolio.openedOn.orEmpty(),
                    sortOrder = if (portfolio.sortOrder != 0) portfolio.sortOrder.toString() else "",
                )
            }
    }
}

/** The values of the open portfolios on one day: one `value:<portfolioId>` field each, blank ones skipped by the server. */
data class PortfolioValuesDraft(
    val date: String = "",
    val note: String = "",
    val values: Map<String, String> = emptyMap(),
) {
    fun toFields(): Map<String, String> =
        fields {
            set("date", date)
            set("note", note)
            values.forEach { (id, value) -> set("value:$id", value) }
        }

    fun toForm(): FormBody = toFields().toFormBody()

    companion object {
        fun from(
            portfolios: List<AccountDetailPortfolio>,
            currency: String,
            today: String,
        ) = PortfolioValuesDraft(
            date = today,
            values = portfolios.associate { it.id to (it.latestValue?.let { value -> Amounts.toInput(value, currency) }.orEmpty()) },
        )
    }
}

/** What the transaction list asks the page for: the filters and the page, as the web reads them from its query string. */
data class TxQuery(
    val from: String = "",
    val to: String = "",
    val q: String = "",
    val min: String = "",
    val max: String = "",
    val page: Int = 1,
) {
    val hasFilters: Boolean get() = from.isNotBlank() || to.isNotBlank() || q.isNotBlank() || min.isNotBlank() || max.isNotBlank()

    /** Blank filters and the first page are left out, like the web's form leaves them. */
    fun toParams(): Map<String, String> =
        buildMap {
            if (from.isNotBlank()) put("from", from.trim())
            if (to.isNotBlank()) put("to", to.trim())
            if (q.isNotBlank()) put("q", q.trim())
            if (min.isNotBlank()) put("min", min.trim())
            if (max.isNotBlank()) put("max", max.trim())
            if (page > 1) put("page", page.toString())
        }
}

internal class Fields {
    val sent = LinkedHashMap<String, String>()

    /** Sets a field; a null value is not sent. */
    fun set(
        name: String,
        value: String?,
    ) {
        if (value != null) sent[name] = value else sent.remove(name)
    }

    /** A checkbox is "on" when ticked and left out otherwise, like a browser does. */
    fun check(
        name: String,
        on: Boolean,
    ) = set(name, if (on) "on" else null)
}

/** The fields a form sends, as a name to value map (what the tests look at). */
internal fun fields(block: Fields.() -> Unit): Map<String, String> = Fields().apply(block).sent

internal fun Map<String, String>.toFormBody(): FormBody = FormBody().also { form -> forEach { (name, value) -> form.set(name, value) } }

/** A form that only carries ids (and other plain values): delete, archive, unlink. */
internal fun idForm(vararg fields: Pair<String, String>): FormBody =
    FormBody().apply { fields.forEach { (name, value) -> set(name, value) } }
