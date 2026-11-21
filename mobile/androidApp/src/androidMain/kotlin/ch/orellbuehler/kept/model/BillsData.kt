package ch.orellbuehler.kept.model

import kotlinx.serialization.Serializable

/** What the PDF reader found in a document: "qr", "text" or "none", and the problems it noticed. */
@Serializable
data class BillExtraction(
    val source: String = "none",
    val warnings: List<String> = emptyList(),
)

/** One bill with its status, as the web's `BillWithStatus`. Amounts are minor units of [currency]. */
@Serializable
data class BillItem(
    val id: String,
    val kind: String = "invoice",
    val creditorName: String? = null,
    val creditorIban: String? = null,
    val amount: Long? = null,
    val currency: String = "",
    val issueDate: String? = null,
    val dueDate: String? = null,
    val reference: String? = null,
    val referenceType: String? = null,
    val message: String? = null,
    val invoiceNumber: String? = null,
    val cancelled: Boolean = false,
    val documentId: String? = null,
    val expectedAccountId: String? = null,
    val notes: String? = null,
    val taxYear: Int? = null,
    val externalUrl: String? = null,
    val extraction: BillExtraction? = null,
    val status: String = "open",
    val settled: Long = 0,
    val remaining: Long? = null,
    val overdue: Boolean = false,
    val dueInDays: Int? = null,
    val lastPaymentDate: String? = null,
    val allocationCount: Int = 0,
) {
    val isCreditNote: Boolean get() = kind == "credit_note"
}

/** A transaction as the bill pages show it. */
@Serializable
data class BillTransaction(
    val id: String,
    val accountId: String = "",
    val accountName: String = "",
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val counterpartyName: String? = null,
    val description: String? = null,
    val reference: String? = null,
)

@Serializable
data class BillSuggestedBill(
    val id: String,
    val kind: String = "invoice",
    val creditorName: String? = null,
    val invoiceNumber: String? = null,
    val amount: Long? = null,
    val currency: String = "",
    val dueDate: String? = null,
)

/** A payment the server proposes for a bill. [amount] is signed in the bill's direction (negative: a refund). */
@Serializable
data class BillSuggestion(
    val billId: String,
    val transactionId: String,
    val rule: String = "reference",
    val confidence: String = "",
    val amount: Long = 0,
    val ambiguous: Boolean = false,
    val auto: Boolean = false,
    val bill: BillSuggestedBill,
    val transaction: BillTransaction,
)

@Serializable
data class BillGroups(
    val overdue: List<BillItem> = emptyList(),
    val dueSoon: List<BillItem> = emptyList(),
    val awaitingRefund: List<BillItem> = emptyList(),
)

@Serializable
data class BillCounts(
    val total: Int = 0,
)

@Serializable
data class BillListQuery(
    val q: String = "",
    val status: String = "all",
    val page: Int = 1,
)

@Serializable
data class BillList(
    val items: List<BillItem> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 25,
    val pageCount: Int = 1,
)

/** `GET pages/bills`. */
@Serializable
data class BillsPage(
    val today: String = "",
    val groups: BillGroups = BillGroups(),
    val suggestions: List<BillSuggestion> = emptyList(),
    val suggestionsTruncated: Boolean = false,
    val matchingFailed: Boolean = false,
    val counts: BillCounts = BillCounts(),
    val autoMatchPending: Int = 0,
    val query: BillListQuery = BillListQuery(),
    val list: BillList = BillList(),
)

@Serializable
data class BillAccountRef(
    val id: String,
    val name: String = "",
    val currency: String = "",
)

/** The bill fields read from a document, as the strings of the form (every one may be missing). */
@Serializable
data class BillDraft(
    val kind: String? = null,
    val creditorName: String? = null,
    val creditorIban: String? = null,
    val amount: String? = null,
    val currency: String? = null,
    val issueDate: String? = null,
    val dueDate: String? = null,
    val reference: String? = null,
    val referenceType: String? = null,
    val message: String? = null,
    val invoiceNumber: String? = null,
)

/** `GET pages/bills/new`, with `?document=<id>` once a document was uploaded. */
@Serializable
data class BillNewPage(
    val accounts: List<BillAccountRef> = emptyList(),
    val draft: BillDraft? = null,
    val documentId: String? = null,
    val extraction: BillExtraction? = null,
)

@Serializable
data class BillLink(
    val id: String = "",
    val label: String = "",
    val url: String = "",
    val source: String = "",
)

@Serializable
data class BillAllocation(
    val id: String,
    val billId: String = "",
    val amount: Long = 0,
    val origin: String = "user",
    val transaction: BillTransaction,
)

/** A transaction that could pay the bill. [suggestedAmount] is what the form is pre-filled with. */
@Serializable
data class BillCandidate(
    val id: String,
    val accountId: String = "",
    val accountName: String = "",
    val bookingDate: String = "",
    val amount: Long = 0,
    val currency: String = "",
    val counterpartyName: String? = null,
    val description: String? = null,
    val reference: String? = null,
    val unallocated: Long = 0,
    val suggestedAmount: Long = 0,
)

@Serializable
data class BillCandidates(
    val items: List<BillCandidate> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20,
    val pageCount: Int = 1,
)

@Serializable
data class BillDocument(
    val id: String,
    val fileName: String = "",
    val mimeType: String = "",
    val size: Long = 0,
)

/** `GET pages/bills/<id>`. */
@Serializable
data class BillDetailPage(
    val bill: BillItem,
    val links: List<BillLink> = emptyList(),
    val allocations: List<BillAllocation> = emptyList(),
    val suggestions: List<BillSuggestion> = emptyList(),
    val dismissed: List<BillTransaction> = emptyList(),
    val candidates: BillCandidates = BillCandidates(),
    val candidateQuery: String = "",
    val accounts: List<BillAccountRef> = emptyList(),
    val document: BillDocument? = null,
)

/** The `data` of the `reextract` action: what the PDF yielded this time. */
@Serializable
data class BillReextractResult(
    val draft: BillDraft? = null,
    val extraction: BillExtraction? = null,
)

/** The `data` of the `matchNow` action. */
@Serializable
data class BillMatchResult(
    val matched: Int = 0,
)
