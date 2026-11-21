package ch.orellbuehler.kept.ui.accounts

import ch.orellbuehler.kept.model.AccountDetailCategory
import ch.orellbuehler.kept.model.AccountImportImpact
import ch.orellbuehler.kept.model.AccountsAccount
import ch.orellbuehler.kept.model.AccountsInstitution
import java.math.BigInteger

const val FULL_SHARE_BPS = 10_000

/** An account counts as stale when its last import is older than this (the web's list). */
const val STALE_IMPORT_DAYS = 45

private const val DAY_MS = 86_400_000L

val ACCOUNT_TYPES = listOf("current", "savings", "credit_card", "investment", "pension", "pillar_3a", "cash", "other")

/** Account types a withdrawal notice can apply to. */
val NOTICE_ACCOUNT_TYPES = setOf("current", "savings", "cash", "other")

val WITHDRAWAL_PERIODS = listOf("month", "year")

val COMMON_CURRENCIES = listOf("CHF", "EUR", "USD", "GBP")

/** The institution colours the web offers. */
val COLOR_PALETTE = listOf("#2563eb", "#0891b2", "#059669", "#65a30d", "#d97706", "#dc2626", "#db2777", "#7c3aed", "#64748b")

fun normalizeIban(input: String): String = input.replace(Regex("\\s+"), "").uppercase()

/** An IBAN in groups of four, as it is shown. */
fun formatIban(input: String): String = normalizeIban(input).chunked(4).joinToString(" ")

/** Country, check digits and the last four characters stay visible; short inputs are masked completely. */
fun maskIban(input: String): String {
    val iban = normalizeIban(input)
    if (iban.length < 12) return formatIban("•".repeat(iban.length))
    return formatIban(iban.take(4) + "•".repeat(iban.length - 8) + iban.takeLast(4))
}

/** An IBAN as the user's `ibanDisplay` preference ("full", "masked", "hidden") shows it; null when hidden. */
fun displayIban(
    iban: String,
    mode: String,
): String? =
    when (mode) {
        "hidden" -> null
        "masked" -> maskIban(iban)
        else -> formatIban(iban)
    }

/** QR-IBANs are CH/LI IBANs whose institution id (digits 5-9) is 30000-31999. */
fun isQrIban(input: String): Boolean {
    val iban = normalizeIban(input)
    if (!Regex("^(CH|LI)\\d{19}$").matches(iban)) return false
    return iban.substring(4, 9).toInt() in 30000..31999
}

/** Spaced display of a payment reference: QR references in groups of five, creditor references (RF…) in fours. */
fun formatReference(input: String): String {
    val ref = input.replace(Regex("\\s+"), "").uppercase()
    return when {
        Regex("^\\d{27}$").matches(ref) -> ref.take(2) + " " + ref.drop(2).chunked(5).joinToString(" ")
        Regex("^RF[0-9A-Z]{2,}$").matches(ref) -> ref.chunked(4).joinToString(" ")
        else -> input.trim()
    }
}

/** `basisPoints / 10000` of an amount, rounded half away from zero, so it never depends on the sign. */
fun shareOf(
    amount: Long,
    basisPoints: Int,
): Long {
    if (basisPoints == FULL_SHARE_BPS) return amount
    val product = BigInteger.valueOf(amount).abs().multiply(BigInteger.valueOf(basisPoints.toLong()))
    val rounded = product.add(BigInteger.valueOf(FULL_SHARE_BPS / 2L)).divide(BigInteger.valueOf(FULL_SHARE_BPS.toLong())).toLong()
    return if (amount < 0) -rounded else rounded
}

/** 5000 is "50", 3333 is "33.33": what the share field is filled with. */
fun shareToInput(basisPoints: Int): String {
    val whole = basisPoints / 100
    val fraction = basisPoints % 100
    return if (fraction == 0) whole.toString() else "$whole.${fraction.toString().padStart(2, '0').trimEnd('0')}"
}

/** "50%", "33.33%". */
fun formatShare(basisPoints: Int): String = shareToInput(basisPoints) + "%"

/** "Parent / Child" for a subcategory, otherwise the name. */
fun categoryLabel(
    category: AccountDetailCategory,
    all: List<AccountDetailCategory>,
): String {
    val parent = category.parentId?.let { id -> all.firstOrNull { it.id == id } }
    return if (parent != null) "${parent.name} / ${category.name}" else category.name
}

class InstitutionGroup(
    /** Null for the accounts without an institution. */
    val institution: AccountsInstitution?,
    val accounts: List<AccountsAccount>,
)

/**
 * The accounts under their institutions: every institution (even without accounts), then the
 * accounts without one. Archived accounts only when [showArchived].
 */
fun groupByInstitution(
    institutions: List<AccountsInstitution>,
    accounts: List<AccountsAccount>,
    showArchived: Boolean,
): List<InstitutionGroup> {
    val visible = if (showArchived) accounts else accounts.filter { !it.archived }
    val groups = institutions.map { institution -> InstitutionGroup(institution, visible.filter { it.institution?.id == institution.id }) }
    val other = visible.filter { it.institution == null }
    return if (other.isEmpty()) groups else groups + InstitutionGroup(null, other)
}

class CurrencyTotal(
    val currency: String,
    val sum: Long,
    val share: Long,
    /** At least one account is only partly yours. */
    val shared: Boolean,
)

/** The sum of the active accounts per currency (not converted), sorted by currency. */
fun currencyTotals(accounts: List<AccountsAccount>): List<CurrencyTotal> =
    accounts
        .filter { !it.archived }
        .groupBy { it.currency }
        .toSortedMap()
        .map { (currency, list) ->
            CurrencyTotal(
                currency = currency,
                sum = list.sumOf { it.balance },
                share = list.sumOf { it.shareBalance },
                shared = list.any { it.shareBps < FULL_SHARE_BPS },
            )
        }

/** Whole days since the last import when it is older than [STALE_IMPORT_DAYS]; null when the import is recent or missing. */
fun staleImportDays(
    lastImportAt: Long?,
    now: Long,
): Int? {
    if (lastImportAt == null) return null
    val days = Math.floorDiv(now - lastImportAt, DAY_MS)
    return if (days > STALE_IMPORT_DAYS) days.toInt() else null
}

enum class ImpactKind { CATEGORIZED, NOTES, TAX_YEARS, DEDUCTION_YEARS, BILL_ALLOCATIONS, PILLAR_3A, TRANSFER_LINKS, MIRRORS }

class ImpactLine(
    val kind: ImpactKind,
    val count: Int,
)

/** One line per kind of user edit that undoing an import would delete; the kinds without edits are left out. */
fun describeImpact(impact: AccountImportImpact): List<ImpactLine> =
    listOf(
        ImpactLine(ImpactKind.CATEGORIZED, impact.categorized),
        ImpactLine(ImpactKind.NOTES, impact.notes),
        ImpactLine(ImpactKind.TAX_YEARS, impact.taxYears),
        ImpactLine(ImpactKind.DEDUCTION_YEARS, impact.deductionYears),
        ImpactLine(ImpactKind.BILL_ALLOCATIONS, impact.billAllocations),
        ImpactLine(ImpactKind.PILLAR_3A, impact.pillar3a),
        ImpactLine(ImpactKind.TRANSFER_LINKS, impact.transferLinks),
        ImpactLine(ImpactKind.MIRRORS, impact.mirrors),
    ).filter { it.count > 0 }
