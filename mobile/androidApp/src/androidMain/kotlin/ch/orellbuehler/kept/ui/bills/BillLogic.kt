package ch.orellbuehler.kept.ui.bills

import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.model.BillDraft
import ch.orellbuehler.kept.model.BillItem

/** The values the bill list can be filtered by, in the order the web offers them. */
val billStatusFilters = listOf("all", "open", "overdue", "paid", "refund", "cancelled")

val billReferenceTypes = listOf("", "QRR", "SCOR", "NON")

val billKinds = listOf("invoice", "credit_note")

/** The query string of `GET pages/bills`: only what differs from the defaults, like the web's URL. */
fun billListQuery(
    q: String,
    status: String,
    page: Int,
): Map<String, String> =
    buildMap {
        if (q.isNotBlank()) put("q", q.trim())
        if (status != "all") put("status", status)
        if (page > 1) put("page", page.toString())
    }

/** The query string of `GET pages/bills/<id>`: the search and page of the payment candidates. */
fun candidateQuery(
    q: String,
    page: Int,
): Map<String, String> =
    buildMap {
        if (q.isNotBlank()) put("q", q.trim())
        if (page > 1) put("page", page.toString())
    }

/** "1–25 of 53" for a page of a list: the first and last row number on it. */
fun pageRange(
    page: Int,
    pageSize: Int,
    total: Int,
): Pair<Int, Int> = if (total == 0) 0 to 0 else ((page - 1) * pageSize + 1) to minOf(total, page * pageSize)

/** How soon a bill is due, as the web's `dueHint`; null when it would add nothing. */
sealed interface DueHint {
    data class Overdue(
        val days: Int,
    ) : DueHint

    data object Today : DueHint

    data object Tomorrow : DueHint

    data class InDays(
        val days: Int,
    ) : DueHint
}

fun dueHint(bill: BillItem): DueHint? {
    val days = bill.dueInDays ?: return null
    if (bill.overdue) return DueHint.Overdue(-days)
    if (bill.status != "open" && bill.status != "partially_paid") return null
    return when {
        days == 0 -> DueHint.Today
        days == 1 -> DueHint.Tomorrow
        days > 1 -> DueHint.InDays(days)
        else -> null
    }
}

/** True when the bill still has to be paid, and a remaining amount is shown next to a partial payment. */
fun showsRemaining(bill: BillItem): Boolean = bill.remaining != null && bill.amount != null && bill.status == "partially_paid"

fun isRefundDue(bill: BillItem): Boolean = bill.status == "credit_due" || bill.status == "overpaid"

/** What to pay: what is left of the bill, or its amount while nothing is matched; null for an open amount. */
fun amountToPay(bill: BillItem): Long? = (bill.remaining ?: bill.amount)?.takeIf { it > 0 }

/** A paid or cancelled bill hides the manual matching until the user asks for it. */
fun candidatesCollapsed(
    bill: BillItem,
    shownFor: String?,
    query: String,
): Boolean = (bill.status == "paid" || bill.status == "cancelled") && shownFor != bill.id && query.isEmpty()

/** "CH44 3199 …": an IBAN in groups of four. */
fun formatIban(input: String): String = compact(input).chunked(4).joinToString(" ")

/** Country, check digits and the last four characters visible; short inputs are masked completely. */
fun maskIban(input: String): String {
    val iban = compact(input)
    if (iban.length < 12) return formatIban("•".repeat(iban.length))
    return formatIban(iban.take(4) + "•".repeat(iban.length - 8) + iban.takeLast(4))
}

/** A payment reference for reading: QRR as 2 + 5x5 digits, SCOR in fours. */
fun formatReference(input: String): String {
    val ref = compact(input)
    if (Regex("^\\d{27}$").matches(ref)) {
        return ref.take(2) + " " + ref.drop(2).chunked(5).joinToString(" ")
    }
    if (Regex("^RF[0-9A-Z]{2,}$").matches(ref)) return ref.chunked(4).joinToString(" ")
    return input.trim()
}

/** Without spaces, upper case: how banking apps take an IBAN or a reference. */
fun compact(input: String): String = input.filterNot { it.isWhitespace() }.uppercase()

/** The document id of a redirect such as "/bills/new?document=abc"; null for any other path. */
fun documentIdOfRedirect(webPath: String): String? {
    if (webPath.substringBefore('?').trim('/') != "bills/new") return null
    val query = webPath.substringAfter('?', "")
    return query
        .split('&')
        .map { it.substringBefore('=') to it.substringAfter('=', "") }
        .firstOrNull { it.first == "document" }
        ?.second
        ?.let { java.net.URLDecoder.decode(it, "UTF-8") }
        ?.takeIf { it.isNotEmpty() }
}

/** The form fields of a bill, as the strings typed into the inputs. */
data class BillFormValues(
    val kind: String = "invoice",
    val creditorName: String = "",
    val creditorIban: String = "",
    val amount: String = "",
    val currency: String = "CHF",
    val issueDate: String = "",
    val dueDate: String = "",
    val reference: String = "",
    val referenceType: String = "",
    val message: String = "",
    val invoiceNumber: String = "",
    val expectedAccountId: String = "",
    val notes: String = "",
    val taxYear: String = "",
) {
    /** The fields the web form submits, in the names of the server's schema. */
    fun fields(): List<Pair<String, String>> =
        listOf(
            "kind" to kind,
            "creditorName" to creditorName,
            "creditorIban" to creditorIban,
            "amount" to amount,
            "currency" to currency,
            "issueDate" to issueDate,
            "dueDate" to dueDate,
            "reference" to reference,
            "referenceType" to referenceType,
            "message" to message,
            "invoiceNumber" to invoiceNumber,
            "expectedAccountId" to expectedAccountId,
            "notes" to notes,
            "taxYear" to taxYear,
        )

    fun toList(): List<String> = fields().map { it.second }

    companion object {
        fun of(list: List<String>): BillFormValues =
            BillFormValues(
                kind = list[0],
                creditorName = list[1],
                creditorIban = list[2],
                amount = list[3],
                currency = list[4],
                issueDate = list[5],
                dueDate = list[6],
                reference = list[7],
                referenceType = list[8],
                message = list[9],
                invoiceNumber = list[10],
                expectedAccountId = list[11],
                notes = list[12],
                taxYear = list[13],
            )
    }
}

/** The names of the fields the form shows errors under; other error keys are folded into the form error. */
val billFormFieldNames =
    setOf(
        "kind",
        "creditorName",
        "creditorIban",
        "amount",
        "currency",
        "issueDate",
        "dueDate",
        "reference",
        "referenceType",
        "message",
        "invoiceNumber",
        "expectedAccountId",
        "notes",
        "taxYear",
        "documentId",
    )

/** The form-level error: the one of no field, or the first error of a field the form has no input for. */
fun billFormError(errors: Map<String, String>): String? =
    errors["form"] ?: errors.entries.firstOrNull { it.key !in billFormFieldNames }?.value

fun billToFormValues(bill: BillItem): BillFormValues =
    BillFormValues(
        kind = bill.kind,
        creditorName = bill.creditorName.orEmpty(),
        creditorIban = bill.creditorIban?.let(::formatIban).orEmpty(),
        amount = bill.amount?.let { Amounts.toInput(it, bill.currency) }.orEmpty(),
        currency = bill.currency,
        issueDate = bill.issueDate.orEmpty(),
        dueDate = bill.dueDate.orEmpty(),
        reference = bill.reference?.let(::formatReference).orEmpty(),
        referenceType = bill.referenceType.orEmpty(),
        message = bill.message.orEmpty(),
        invoiceNumber = bill.invoiceNumber.orEmpty(),
        expectedAccountId = bill.expectedAccountId.orEmpty(),
        notes = bill.notes.orEmpty(),
        taxYear = bill.taxYear?.toString().orEmpty(),
    )

/** The form of a new bill: empty, or filled with what was read from an uploaded document. */
fun draftToFormValues(
    draft: BillDraft?,
    defaultCurrency: String,
): BillFormValues {
    val empty = BillFormValues(currency = defaultCurrency)
    if (draft == null) return empty
    return empty.copy(
        kind = draft.kind?.takeIf { it.isNotEmpty() } ?: empty.kind,
        creditorName = draft.creditorName.orEmpty(),
        creditorIban = draft.creditorIban?.let(::formatIban).orEmpty(),
        amount = draft.amount.orEmpty(),
        currency = draft.currency?.takeIf { it.isNotEmpty() } ?: defaultCurrency,
        issueDate = draft.issueDate.orEmpty(),
        dueDate = draft.dueDate.orEmpty(),
        reference = draft.reference?.let(::formatReference).orEmpty(),
        referenceType = draft.referenceType.orEmpty(),
        message = draft.message.orEmpty(),
        invoiceNumber = draft.invoiceNumber.orEmpty(),
    )
}

/**
 * Lays the values of a re-read document over the stored bill, for review. Only what the document
 * yielded replaces stored values; the kind never changes, and the currency changes only when it
 * came from a QR code and no payment is matched yet.
 */
fun mergeRereadDraft(
    base: BillFormValues,
    draft: BillDraft,
    source: String,
    hasAllocations: Boolean,
): BillFormValues {
    fun pick(
        value: String?,
        stored: String,
    ) = value?.takeIf { it.isNotEmpty() } ?: stored
    val merged =
        base.copy(
            creditorName = pick(draft.creditorName, base.creditorName),
            creditorIban = pick(draft.creditorIban, base.creditorIban),
            amount = pick(draft.amount, base.amount),
            issueDate = pick(draft.issueDate, base.issueDate),
            dueDate = pick(draft.dueDate, base.dueDate),
            reference = pick(draft.reference, base.reference),
            referenceType = pick(draft.referenceType, base.referenceType),
            message = pick(draft.message, base.message),
            invoiceNumber = pick(draft.invoiceNumber, base.invoiceNumber),
        )
    return merged.copy(
        creditorIban = if (merged.creditorIban.isNotEmpty()) formatIban(merged.creditorIban) else "",
        reference = if (merged.reference.isNotEmpty()) formatReference(merged.reference) else "",
        currency =
            if (source == "qr" && !hasAllocations && !draft.currency.isNullOrEmpty()) draft.currency else merged.currency,
    )
}
