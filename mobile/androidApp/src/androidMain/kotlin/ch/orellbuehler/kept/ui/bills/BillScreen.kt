package ch.orellbuehler.kept.ui.bills

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.Amounts
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.BillAllocation
import ch.orellbuehler.kept.model.BillCandidate
import ch.orellbuehler.kept.model.BillDetailPage
import ch.orellbuehler.kept.model.BillDraft
import ch.orellbuehler.kept.model.BillItem
import ch.orellbuehler.kept.model.BillReextractResult
import ch.orellbuehler.kept.model.BillSuggestion
import ch.orellbuehler.kept.model.BillTransaction
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSdk
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.KeyValueRow
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The search and page of the manual matching list. */
data class CandidateFilter(
    val q: String = "",
    val page: Int = 1,
)

/** What a re-read of the document yielded, waiting to be reviewed in the edit form. */
data class BillReview(
    val draft: BillDraft,
    val source: String,
)

class BillViewModel(
    sdk: KeptSdk,
    private val id: String,
    private val filter: MutableStateFlow<CandidateFilter> = MutableStateFlow(CandidateFilter()),
) : PageViewModel<BillDetailPage>(sdk, { it.load("bills/$id", candidateQuery(filter.value.q, filter.value.page)) }) {
    private val path = "bills/$id"

    private val mutableReview = MutableStateFlow<BillReview?>(null)
    val review: StateFlow<BillReview?> = mutableReview.asStateFlow()

    private val mutableDone = MutableStateFlow(0)

    /** Counts the saves of forms that are open in a sheet: a change tells the screen to close it. */
    val done: StateFlow<Int> = mutableDone.asStateFlow()

    fun clearReview() {
        mutableReview.value = null
    }

    fun notify(text: String) = message(text)

    fun searchCandidates(q: String) {
        filter.value = CandidateFilter(q.trim(), 1)
        refresh()
    }

    fun goToCandidates(page: Int) {
        filter.value = filter.value.copy(page = page)
        refresh()
    }

    fun update(values: BillFormValues) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        submit(path, "update", form) { mutableDone.value++ }
    }

    fun setCancelled(cancelled: Boolean) = submit(path, if (cancelled) "cancel" else "uncancel", showRefusal = true)

    fun delete() = submit(path, "delete", showRefusal = true, reload = false)

    fun allocate(
        transactionId: String,
        amount: String,
    ) {
        submit(path, "allocate", FormBody().set("transactionId", transactionId).set("amount", amount)) { mutableDone.value++ }
    }

    fun confirm(suggestion: BillSuggestion) {
        submit(
            path,
            "allocate",
            FormBody()
                .set(
                    "transactionId",
                    suggestion.transactionId,
                ).set("amount", Amounts.toInput(suggestion.amount, suggestion.bill.currency)),
            showRefusal = true,
        )
    }

    fun dismiss(transactionId: String) =
        submit(path, "dismissSuggestion", FormBody().set("transactionId", transactionId), showRefusal = true)

    fun undismiss(transactionId: String) = submit(path, "undismiss", FormBody().set("transactionId", transactionId), showRefusal = true)

    fun removeAllocation(allocationId: String) =
        submit(path, "removeAllocation", FormBody().set("allocationId", allocationId), showRefusal = true)

    fun attachDocument(prep: UploadPrep.Ready) {
        submit(path, "attachDocument", FormBody().file("file", prep.fileName, "application/pdf", prep.base64), showRefusal = true)
    }

    fun reextract() {
        submit(path, "reextract", showRefusal = true, reload = false) { result ->
            val parsed = runCatching { ApiJson.decodeFromString<BillReextractResult>(result.json) }.getOrNull()
            val draft = parsed?.draft
            if (draft != null) mutableReview.value = BillReview(draft, parsed.extraction?.source ?: "none")
        }
    }
}

/** One bill: what it is, how to pay it, its document and payments, and everything that can be done to it. */
@Composable
fun BillScreen(
    id: String,
    nav: Navigator,
) {
    val vm = keptViewModel(key = "bill-$id") { BillViewModel(it, id) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val review by vm.review.collectAsStateWithLifecycle()
    val done by vm.done.collectAsStateWithLifecycle()

    val page = (state as? Load.Ready)?.value
    var editOpen by rememberSaveable { mutableStateOf(false) }
    var editKey by rememberSaveable { mutableIntStateOf(0) }
    var deleteOpen by rememberSaveable { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var allocatingId by rememberSaveable { mutableStateOf<String?>(null) }

    fun openEdit() {
        vm.clearReview()
        vm.clearFormErrors()
        editKey++
        editOpen = true
    }

    androidx.compose.runtime.LaunchedEffect(review) {
        if (review != null) {
            vm.clearFormErrors()
            editKey++
            editOpen = true
        }
    }
    androidx.compose.runtime.LaunchedEffect(done) {
        if (done > 0) {
            editOpen = false
            allocatingId = null
            vm.clearReview()
        }
    }

    PageScaffold(
        title = page?.bill?.creditorName ?: stringResource(R.string.bills_bill),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { if (it is UiEvent.Navigate) nav.back() },
        actions = {
            if (page != null) {
                IconButton(onClick = ::openEdit) { Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.edit)) }
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(if (page.bill.cancelled) R.string.bills_uncancel else R.string.bills_cancel_bill)) },
                        onClick = {
                            menuOpen = false
                            vm.setCancelled(!page.bill.cancelled)
                        },
                    )
                    if (page.bill.documentId != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.bills_reread)) },
                            onClick = {
                                menuOpen = false
                                vm.reextract()
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                        onClick = {
                            menuOpen = false
                            deleteOpen = true
                        },
                    )
                }
            }
        },
    ) { data, padding ->
        ScrollColumn(padding) {
            BillDetail(data, vm, busy, errors, onAllocate = { allocatingId = it })
        }
    }

    if (page != null && editOpen) {
        val bill = page.bill
        val form =
            rememberBillFormState(editKey) {
                val base = billToFormValues(bill)
                review?.let { mergeRereadDraft(base, it.draft, it.source, bill.allocationCount > 0) } ?: base
            }
        FormSheet(
            title = stringResource(R.string.bills_edit_title),
            onDismiss = {
                editOpen = false
                vm.clearReview()
            },
            onSubmit = { vm.update(form.values) },
            busy = busy,
            error = billFormError(errors),
        ) {
            if (review != null) HintText(stringResource(R.string.bills_review_hint))
            BillFormFields(form, page.accounts, errors, lockKindAndCurrency = bill.allocationCount > 0)
        }
    }
    val allocating = page?.candidates?.items?.firstOrNull { it.id == allocatingId }
    if (page != null && allocating != null) {
        AllocateSheet(allocating, page.bill.currency, busy, errors, onDismiss = { allocatingId = null }, onSubmit = vm::allocate)
    }
    if (deleteOpen) {
        ConfirmDialog(
            title = stringResource(R.string.bills_delete_title),
            text = stringResource(R.string.bills_delete_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = vm::delete,
            onDismiss = { deleteOpen = false },
        )
    }
}

@Composable
private fun AllocateSheet(
    candidate: BillCandidate,
    currency: String,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (String, String) -> Unit,
) {
    val formats = LocalFormats.current
    var amount by rememberSaveable(candidate.id) { mutableStateOf(Amounts.toInput(candidate.suggestedAmount, currency)) }
    val refund = candidate.suggestedAmount < 0
    FormSheet(
        title = stringResource(R.string.bills_allocate_title),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(candidate.id, amount) },
        busy = busy,
        error = errors["form"] ?: errors["transactionId"],
        submitLabel = stringResource(R.string.bills_allocate),
    ) {
        Column {
            Text(transactionTitle(candidate.asTransaction()), style = MaterialTheme.typography.bodyLarge)
            HintText(
                "${candidate.accountName} · ${formats.date(
                    candidate.bookingDate,
                )} · ${formats.signedMoney(candidate.amount, candidate.currency)}",
            )
        }
        AmountField(
            label = stringResource(if (refund) R.string.bills_refund_amount else R.string.bills_amount_to_apply),
            value = amount,
            onValueChange = { amount = it },
            error = errors["amount"],
            currency = currency,
            hint = if (refund) stringResource(R.string.bills_refund_hint) else null,
        )
    }
}

private fun BillCandidate.asTransaction() =
    BillTransaction(id, accountId, accountName, bookingDate, amount, currency, counterpartyName, description, reference)

@Composable
private fun BillDetail(
    data: BillDetailPage,
    vm: BillViewModel,
    busy: Boolean,
    errors: Map<String, String>,
    onAllocate: (String) -> Unit,
) {
    val bill = data.bill
    Summary(bill)
    PaymentSlip(bill, vm)
    Details(data)
    DocumentCard(data, vm, busy)
    PaymentsCard(data, vm, busy)
    MatchCard(data, vm, onAllocate)
}

@Composable
private fun Summary(bill: BillItem) {
    val formats = LocalFormats.current
    val hint = dueHint(bill)
    SectionCard(title = bill.creditorName ?: stringResource(R.string.bills_unnamed_creditor)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusPill(bill.status)
            if (bill.isCreditNote) Pill(stringResource(R.string.bills_kind_credit_note))
        }
        val line =
            buildList {
                bill.invoiceNumber?.let { add(stringResource(R.string.bills_number, it)) }
                add(
                    bill.dueDate?.let {
                        stringResource(
                            R.string.bills_due,
                            formats.date(it),
                        )
                    } ?: stringResource(R.string.bills_no_due_date),
                )
                hint?.let { add(dueHintText(it)) }
            }
        HintText(
            line.joinToString(" · "),
            Modifier.padding(top = 8.dp),
            if (bill.overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Figure(stringResource(R.string.bills_amount), bill.amount, bill.currency, Modifier.weight(1f))
            Figure(stringResource(R.string.bills_settled), bill.settled, bill.currency, Modifier.weight(1f))
            Figure(stringResource(R.string.bills_remaining_label), bill.remaining, bill.currency, Modifier.weight(1f))
        }
    }
}

@Composable
private fun Figure(
    label: String,
    minor: Long?,
    currency: String,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        HintText(label)
        if (minor != null) {
            AmountText(minor, currency, style = MaterialTheme.typography.titleMedium)
        } else {
            Text(stringResource(R.string.bills_open_amount), style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** What a banking app asks for when the bill is paid by hand, each with a copy button. */
@Composable
private fun PaymentSlip(
    bill: BillItem,
    vm: BillViewModel,
) {
    val context = LocalContext.current
    val ibanDisplay = LocalSession.current?.preferences?.ibanDisplay ?: "full"
    val iban = bill.creditorIban?.takeIf { ibanDisplay != "hidden" }
    val toPay = amountToPay(bill)
    if (iban == null && bill.reference == null && bill.message == null && toPay == null) return
    val copied = stringResource(R.string.bills_copied)

    fun copy(
        label: String,
        text: String,
        sensitive: Boolean = false,
    ) {
        copyToClipboard(context, label, text, sensitive)
        vm.notify(copied)
    }
    SectionCard(title = stringResource(R.string.bills_slip_title), contentPadding = false) {
        val rows = mutableListOf<@Composable () -> Unit>()
        if (iban != null) {
            val label = stringResource(R.string.bills_iban)
            rows += {
                SlipRow(label, if (ibanDisplay == "masked") maskIban(iban) else formatIban(iban), true) { copy(label, compact(iban), true) }
            }
        }
        if (bill.reference != null) {
            val label = stringResource(R.string.bills_reference)
            val value = formatReference(bill.reference) + (bill.referenceType?.let { " ($it)" }.orEmpty())
            rows += { SlipRow(label, value, true) { copy(label, compact(bill.reference)) } }
        }
        if (toPay != null) {
            val label = stringResource(R.string.bills_amount_to_pay)
            rows += {
                SlipRow(
                    label,
                    LocalFormats.current.money(toPay, bill.currency),
                    false,
                ) { copy(label, Amounts.toInput(toPay, bill.currency)) }
            }
        }
        if (bill.message != null) {
            val label = stringResource(R.string.bills_message)
            rows += { SlipRow(label, bill.message, false) { copy(label, bill.message) } }
        }
        rows.forEachIndexed { index, row ->
            if (index > 0) RowDivider()
            row()
        }
    }
}

@Composable
private fun SlipRow(
    label: String,
    value: String,
    mono: Boolean,
    onCopy: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            HintText(label)
            Text(
                value,
                style = MaterialTheme.typography.bodyLarge,
                fontFamily = if (mono) FontFamily.Monospace else null,
            )
        }
        IconButton(onClick = onCopy) {
            Icon(Icons.Outlined.ContentCopy, contentDescription = stringResource(R.string.bills_copy, label))
        }
    }
}

@Composable
private fun Details(data: BillDetailPage) {
    val formats = LocalFormats.current
    val context = LocalContext.current
    val bill = data.bill
    val account = data.accounts.firstOrNull { it.id == bill.expectedAccountId }?.name
    val externalUrl = bill.externalUrl?.takeIf { it.startsWith("http://", true) || it.startsWith("https://", true) }
    if (bill.issueDate == null &&
        account == null &&
        bill.taxYear == null &&
        bill.notes == null &&
        externalUrl == null &&
        data.links.isEmpty()
    ) {
        return
    }
    SectionCard(title = stringResource(R.string.bills_details)) {
        bill.issueDate?.let { KeyValueRow(stringResource(R.string.bills_issued), formats.date(it)) }
        account?.let { KeyValueRow(stringResource(R.string.bills_pays_from), it) }
        bill.taxYear?.let { KeyValueRow(stringResource(R.string.bills_tax_year), it.toString()) }
        bill.notes?.let { KeyValueRow(stringResource(R.string.bills_notes), it) }
        externalUrl?.let { url ->
            TextButton(onClick = { openLink(context, url) }) {
                Icon(Icons.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_open_source), modifier = Modifier.padding(start = 6.dp))
            }
        }
        data.links.filter { it.url.startsWith("http://", true) || it.url.startsWith("https://", true) }.forEach { link ->
            TextButton(onClick = { openLink(context, link.url) }) {
                Icon(Icons.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(link.label.ifBlank { link.url }, modifier = Modifier.padding(start = 6.dp), maxLines = 1)
            }
        }
    }
}

@Composable
private fun DocumentCard(
    data: BillDetailPage,
    vm: BillViewModel,
    busy: Boolean,
) {
    val context = LocalContext.current
    val sdk = LocalSdk.current
    val scope = rememberCoroutineScope()
    var opening by remember { mutableStateOf(false) }
    val tooLarge = stringResource(R.string.bills_upload_too_large)
    val notSupported = stringResource(R.string.bills_upload_not_supported)
    val unreadable = stringResource(R.string.bills_upload_unreadable)
    val noApp = stringResource(R.string.bills_no_app)
    val openFailed = stringResource(R.string.bills_open_failed)
    val source =
        rememberDocumentSource { prep ->
            when (prep) {
                is UploadPrep.Ready -> vm.attachDocument(prep)
                UploadPrep.TooLarge -> vm.notify(tooLarge)
                UploadPrep.NotSupported -> vm.notify(notSupported)
                UploadPrep.Unreadable -> vm.notify(unreadable)
            }
        }
    val document = data.document
    val working = busy || source.reading
    SectionCard(title = stringResource(R.string.bills_document)) {
        if (document != null) {
            ListRow(
                title = document.fileName,
                subtitle = Formatter.formatFileSize(context, document.size),
                modifier = Modifier.padding(horizontal = 0.dp),
            ) {
                if (opening) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                } else {
                    TextButton(onClick = {
                        opening = true
                        scope.launch {
                            try {
                                if (openBillDocument(context, sdk, data.bill.id, document.fileName) == OpenResult.NoApp) vm.notify(noApp)
                            } catch (e: KeptException) {
                                vm.notify(e.message.orEmpty())
                            } catch (e: java.io.IOException) {
                                vm.notify(openFailed)
                            } finally {
                                opening = false
                            }
                        }
                    }) { Text(stringResource(R.string.bills_open_document)) }
                }
            }
        } else {
            HintText(stringResource(R.string.bills_no_document))
        }
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = source.pickFile, enabled = !working) {
                Icon(Icons.Outlined.UploadFile, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(
                    stringResource(if (document != null) R.string.bills_replace_file else R.string.bills_attach_file),
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
            OutlinedButton(onClick = source.takePhoto, enabled = !working) {
                Icon(Icons.Outlined.PhotoCamera, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_take_photo), modifier = Modifier.padding(start = 6.dp))
            }
        }
        if (source.reading || (busy && document == null)) {
            HintText(stringResource(R.string.bills_uploading), Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun PaymentsCard(
    data: BillDetailPage,
    vm: BillViewModel,
    busy: Boolean,
) {
    val bill = data.bill
    var removing by rememberSaveable { mutableStateOf<String?>(null) }
    SectionCard(title = stringResource(R.string.bills_payments), contentPadding = false) {
        if (data.allocations.isEmpty()) {
            HintText(stringResource(R.string.bills_no_payments), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        }
        data.allocations.forEachIndexed { index, allocation ->
            if (index > 0) RowDivider()
            AllocationRow(allocation, bill.currency) { removing = allocation.id }
        }
        if (data.suggestions.isNotEmpty()) {
            RowDivider()
            SubHeader(stringResource(R.string.bills_suggestions))
            data.suggestions.forEachIndexed { index, suggestion ->
                if (index > 0) RowDivider()
                SuggestionBlock(
                    suggestion = suggestion,
                    showBill = false,
                    busy = busy,
                    onConfirm = { vm.confirm(suggestion) },
                    onDismiss = { vm.dismiss(suggestion.transactionId) },
                )
            }
        }
        if (data.dismissed.isNotEmpty()) {
            RowDivider()
            SubHeader(stringResource(R.string.bills_dismissed))
            data.dismissed.forEachIndexed { index, tx ->
                if (index > 0) RowDivider()
                DismissedRow(tx, busy) { vm.undismiss(tx.id) }
            }
        }
    }
    val target = data.allocations.firstOrNull { it.id == removing }
    if (target != null) {
        ConfirmDialog(
            title = stringResource(R.string.bills_remove_payment_title),
            text = stringResource(R.string.bills_remove_payment_text),
            confirmLabel = stringResource(R.string.bills_remove),
            onConfirm = { vm.removeAllocation(target.id) },
            onDismiss = { removing = null },
        )
    }
}

@Composable
private fun SubHeader(text: String) {
    Text(
        text,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun AllocationRow(
    allocation: BillAllocation,
    currency: String,
    onRemove: () -> Unit,
) {
    val formats = LocalFormats.current
    val tx = allocation.transaction
    ListRow(
        title = transactionTitle(tx),
        subtitle = "${tx.accountName} · ${formats.date(tx.bookingDate)}",
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(horizontalAlignment = Alignment.End) {
                AmountText(allocation.amount, currency, tone = AmountTone.SIGNED)
                Pill(stringResource(if (allocation.origin == "auto") R.string.bills_origin_auto else R.string.bills_origin_manual))
            }
            IconButton(onClick = onRemove) {
                Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.bills_remove_payment))
            }
        }
    }
}

@Composable
private fun DismissedRow(
    tx: BillTransaction,
    busy: Boolean,
    onRestore: () -> Unit,
) {
    val formats = LocalFormats.current
    ListRow(
        title = transactionTitle(tx),
        subtitle = "${tx.accountName} · ${formats.date(tx.bookingDate)} · ${formats.signedMoney(tx.amount, tx.currency)}",
    ) {
        TextButton(onClick = onRestore, enabled = !busy) { Text(stringResource(R.string.bills_restore)) }
    }
}

@Composable
private fun MatchCard(
    data: BillDetailPage,
    vm: BillViewModel,
    onAllocate: (String) -> Unit,
) {
    val formats = LocalFormats.current
    val bill = data.bill
    var shownFor by rememberSaveable { mutableStateOf<String?>(null) }
    var text by rememberSaveable { mutableStateOf(data.candidateQuery) }
    SectionCard(
        title = stringResource(R.string.bills_match_title),
        subtitle = stringResource(R.string.bills_match_text),
        contentPadding = false,
    ) {
        if (candidatesCollapsed(bill, shownFor, data.candidateQuery)) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                HintText(
                    stringResource(if (bill.status == "cancelled") R.string.bills_collapsed_cancelled else R.string.bills_collapsed_paid),
                    Modifier.weight(1f),
                )
                OutlinedButton(onClick = { shownFor = bill.id }) { Text(stringResource(R.string.bills_show_anyway)) }
            }
            return@SectionCard
        }
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            placeholder = { Text(stringResource(R.string.bills_candidates_search)) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { vm.searchCandidates(text) }),
        )
        val candidates = data.candidates
        if (candidates.items.isEmpty()) {
            HintText(
                if (data.candidateQuery.isNotEmpty()) {
                    stringResource(R.string.bills_candidates_none_query, data.candidateQuery)
                } else {
                    stringResource(R.string.bills_candidates_none, bill.currency)
                },
                Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
            )
            return@SectionCard
        }
        candidates.items.forEach { candidate ->
            RowDivider()
            ListRow(
                title = transactionTitle(candidate.asTransaction()),
                subtitle =
                    listOfNotNull(
                        candidate.description.takeIf { candidate.counterpartyName != null },
                        "${candidate.accountName} · ${formats.date(candidate.bookingDate)}",
                    ).joinToString("\n"),
                onClick = { onAllocate(candidate.id) },
                showChevron = true,
            ) {
                AmountText(candidate.amount, candidate.currency, tone = AmountTone.SIGNED)
                if (Math.abs(candidate.unallocated) != Math.abs(candidate.amount)) {
                    HintText(stringResource(R.string.bills_unallocated, formats.money(Math.abs(candidate.unallocated), candidate.currency)))
                }
            }
        }
        if (candidates.pageCount > 1) {
            RowDivider()
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { vm.goToCandidates(candidates.page - 1) }, enabled = candidates.page > 1) {
                    Text(stringResource(R.string.bills_previous))
                }
                Text(
                    stringResource(R.string.bills_page_of, candidates.page, candidates.pageCount),
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedButton(onClick = { vm.goToCandidates(candidates.page + 1) }, enabled = candidates.page < candidates.pageCount) {
                    Text(stringResource(R.string.bills_next))
                }
            }
        }
    }
}
