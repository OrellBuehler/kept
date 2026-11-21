import QuickLook
import SwiftUI
import UIKit

/// One bill: status and amounts, what is needed to pay it, its document, and its payments.
/// Reminder notifications open this screen on its own, so it loads everything it needs itself.
struct BillView: View {
    let id: String
    @State private var store: PageStore<BillDetailPage>

    init(id: String) {
        self.id = id
        _store = State(initialValue: PageStore<BillDetailPage>(path: "bills/\(id)"))
    }

    var body: some View {
        PageView("Bill", store: store) { page in
            BillDetailContent(store: store, page: page)
        }
    }
}

private struct BillDetailContent: View {
    let store: PageStore<BillDetailPage>
    let page: BillDetailPage

    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats
    @Environment(\.session) private var session

    @State private var editing = false
    @State private var editValues = BillFormValues()
    @State private var editNote: String?
    @State private var confirmDelete = false
    @State private var showIban = false
    @State private var copied: String?
    @State private var preview: URL?
    @State private var openingDocument = false
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var showScanner = false
    @State private var allocating: BillCandidate?
    @State private var removing: BillDetailPage.Allocation?
    @State private var candidateSearch = ""
    @State private var showCandidates = false
    @State private var searchLoaded = false

    private var bill: BillRecord { page.bill }

    var body: some View {
        List {
            summarySection
            paySection
            detailsSection
            documentSection
            paymentsSection
            suggestionsSection
            dismissedSection
            candidatesSection
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { actionsMenu }
        }
        .billDocumentSources(
            showFiles: $showFiles,
            showPhotos: $showPhotos,
            showScanner: $showScanner,
            onPicked: { document in Task { await attach(document) } },
            onFailed: { message in store.message = message }
        )
        .quickLookPreview($preview)
        .sheet(isPresented: $editing) { editSheet }
        .sheet(item: $allocating) { candidate in
            BillAllocateSheet(store: store, candidate: candidate, currency: bill.currency)
        }
        .confirmationDialog("Delete this bill?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteBill() } }
        } message: {
            Text("The bill and its matched payments are removed. The transactions themselves stay in your accounts. An uploaded PDF is deleted with it.")
        }
        .confirmationDialog("Remove this payment from the bill?", isPresented: removeDialog, titleVisibility: .visible) {
            if let allocation = removing {
                Button("Remove", role: .destructive) { Task { await remove(allocation) } }
            }
        }
        .onAppear {
            if !searchLoaded {
                searchLoaded = true
                candidateSearch = page.candidateQuery
            }
        }
    }

    private var removeDialog: Binding<Bool> {
        Binding(
            get: { removing != nil },
            set: { shown in if !shown { removing = nil } }
        )
    }

    // MARK: Toolbar

    private var actionsMenu: some View {
        Menu {
            Button {
                openEdit()
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button {
                Task { await toggleCancel() }
            } label: {
                if bill.cancelled {
                    Label("Uncancel", systemImage: "checkmark.circle")
                } else {
                    Label("Cancel bill", systemImage: "xmark.circle")
                }
            }
            if bill.documentId != nil {
                Button {
                    Task { await reextract() }
                } label: {
                    Label("Re-read PDF", systemImage: "arrow.clockwise")
                }
            }
            Divider()
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(store.busy)
        .accessibilityLabel("Actions")
    }

    // MARK: Summary

    private var summarySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(bill.creditorName ?? "Unnamed creditor").font(.title3.weight(.semibold))
                HStack(spacing: 6) {
                    BillStatusPill(status: bill.status, overdue: bill.overdue)
                    if bill.kind == "credit_note" { Pill("Credit note") }
                }
                dueLine
            }
            .padding(.vertical, 2)
            LabeledContent("Amount") {
                if let amount = bill.amount {
                    AmountText(amount, bill.currency).fontWeight(.semibold)
                } else {
                    Text("Open amount").foregroundStyle(.secondary)
                }
            }
            LabeledContent("Settled") {
                AmountText(bill.settled, bill.currency).fontWeight(.semibold)
            }
            LabeledContent("Remaining") {
                if let remaining = bill.remaining {
                    AmountText(remaining, bill.currency).fontWeight(.semibold)
                } else {
                    Text("\u{2013}").foregroundStyle(.secondary)
                }
            }
        }
    }

    private var dueLine: some View {
        let hint = BillText.dueHint(dueInDays: bill.dueInDays, overdue: bill.overdue, status: bill.status)
        return VStack(alignment: .leading, spacing: 2) {
            if let number = bill.invoiceNumber, !number.isEmpty {
                Text("No. " + number).font(.subheadline).foregroundStyle(.secondary)
            }
            if let due = bill.dueDate {
                Text("Due " + formats.date(due)).font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("No due date").font(.subheadline).foregroundStyle(.secondary)
            }
            if let hint {
                Text(hint)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(bill.overdue ? KeptColor.negative : Color.primary)
            }
        }
    }

    // MARK: Payment slip

    private var ibanMode: String {
        session?.preferences.ibanDisplay ?? "full"
    }

    private var showsAmountCopy: Bool {
        let open = bill.status == "open" || bill.status == "partially_paid"
        return open && BillText.payableAmount(bill) != nil
    }

    @ViewBuilder
    private var paySection: some View {
        let iban = bill.creditorIban ?? ""
        let hasIban = !iban.isEmpty && ibanMode != "hidden"
        let reference = bill.reference ?? ""
        let message = bill.message ?? ""
        if hasIban || !reference.isEmpty || !message.isEmpty || showsAmountCopy {
            Section {
                if hasIban { ibanRow(iban) }
                if !reference.isEmpty { referenceRow(reference) }
                if !message.isEmpty { messageRow(message) }
                if showsAmountCopy { amountRow() }
            } header: {
                Text("Payment slip")
            } footer: {
                Text("Copy what your banking app asks for.")
            }
        }
    }

    private func ibanRow(_ iban: String) -> some View {
        let masked = ibanMode == "masked" && !showIban
        let display = masked ? BillText.maskIban(iban) : BillText.groupIban(iban)
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("IBAN").font(.caption).foregroundStyle(.secondary)
                Text(display).font(.body.monospaced())
                if ibanMode == "masked" {
                    Button(showIban ? "Hide" : "Show") { showIban.toggle() }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }
            }
            Spacer()
            copyButton(label: "IBAN", value: BillText.normalizeIban(iban), key: "iban")
        }
    }

    private func referenceRow(_ reference: String) -> some View {
        let type = bill.referenceType.map { " (" + $0 + ")" } ?? ""
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Reference" + type).font(.caption).foregroundStyle(.secondary)
                Text(BillText.groupReference(reference)).font(.body.monospaced())
            }
            Spacer()
            copyButton(label: "reference", value: BillText.normalizeIban(reference), key: "reference")
        }
    }

    private func messageRow(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Message").font(.caption).foregroundStyle(.secondary)
            Text(message).textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func amountRow() -> some View {
        if let payable = BillText.payableAmount(bill) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Amount to pay").font(.caption).foregroundStyle(.secondary)
                    AmountText(payable, bill.currency)
                }
                Spacer()
                copyButton(label: "amount", value: Formats.amountInput(payable, bill.currency), key: "amount")
            }
        }
    }

    private func copyButton(label: String, value: String, key: String) -> some View {
        Button {
            copy(value, key: key)
        } label: {
            Image(systemName: copied == key ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Copy " + label)
    }

    private func copy(_ text: String, key: String) {
        UIPasteboard.general.string = text
        copied = key
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if copied == key { copied = nil }
        }
    }

    // MARK: Details

    @ViewBuilder
    private var detailsSection: some View {
        let account = page.accounts.first { $0.id == bill.expectedAccountId }
        let sourceURL = BillText.webURL(bill.externalUrl)
        let hasDetails = bill.issueDate != nil || account != nil || bill.taxYear != nil
            || (bill.notes ?? "").isEmpty == false || sourceURL != nil || !page.links.isEmpty
        if hasDetails {
            Section("Details") {
                if let issued = bill.issueDate {
                    LabeledContent("Issued", value: formats.date(issued))
                }
                if let account {
                    LabeledContent("Pays from", value: account.name)
                }
                if let year = bill.taxYear {
                    LabeledContent("Tax year", value: String(year))
                }
                if let notes = bill.notes, !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notes").font(.caption).foregroundStyle(.secondary)
                        Text(notes)
                    }
                }
                if let sourceURL {
                    Link(destination: sourceURL) {
                        Label("Open source document", systemImage: "arrow.up.right.square")
                    }
                }
                ForEach(page.links) { link in
                    linkRow(link)
                }
            }
        }
    }

    @ViewBuilder
    private func linkRow(_ link: BillDetailPage.ExternalLink) -> some View {
        if let url = BillText.webURL(link.url) {
            Link(destination: url) {
                Label(link.label, systemImage: "link")
            }
        } else {
            Label(link.label, systemImage: "link").foregroundStyle(.secondary)
        }
    }

    // MARK: Document

    private var documentSection: some View {
        Section {
            if let document = page.document {
                HStack {
                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(document.fileName).lineLimit(1)
                        Text(BillText.fileSize(document.size)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if openingDocument {
                        ProgressView()
                    } else {
                        Button("Open") { Task { await openDocument() } }
                            .buttonStyle(.borderless)
                    }
                }
            } else {
                Text("No PDF attached yet.").foregroundStyle(.secondary)
            }
            BillDocumentButtons(
                showFiles: $showFiles,
                showPhotos: $showPhotos,
                showScanner: $showScanner,
                disabled: store.busy
            )
        } header: {
            Text("Document")
        } footer: {
            Text(page.document == nil ? "Attach a PDF, a photo or a scan. Up to 20 MB." : "Choosing a file replaces the PDF. Up to 20 MB.")
        }
    }

    // MARK: Payments

    private var paymentsSection: some View {
        Section("Payments") {
            if page.allocations.isEmpty {
                Text("No payments matched to this bill yet.").foregroundStyle(.secondary)
            }
            ForEach(page.allocations) { allocation in
                allocationRow(allocation)
            }
        }
    }

    private func allocationRow(_ allocation: BillDetailPage.Allocation) -> some View {
        let tx = allocation.transaction
        let subtitle = tx.accountName + " \u{00B7} " + formats.date(tx.bookingDate)
        return ValueRow(tx.title, subtitle: subtitle) {
            AmountText(allocation.amount, bill.currency).fontWeight(.semibold)
            Pill(allocation.origin == "auto" ? "auto" : "manual")
        }
        .swipeActions {
            Button(role: .destructive) {
                removing = allocation
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private var suggestionsSection: some View {
        if !page.suggestions.isEmpty {
            Section("Suggestions to confirm") {
                ForEach(page.suggestions) { suggestion in
                    BillSuggestionRow(
                        suggestion: suggestion,
                        showBill: false,
                        busy: store.busy,
                        onConfirm: { Task { await confirm(suggestion) } },
                        onDismiss: { Task { await dismiss(suggestion) } }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var dismissedSection: some View {
        if !page.dismissed.isEmpty {
            Section("Dismissed suggestions") {
                ForEach(page.dismissed) { transaction in
                    dismissedRow(transaction)
                }
            }
        }
    }

    private func dismissedRow(_ transaction: BillTransaction) -> some View {
        let subtitle = transaction.accountName + " \u{00B7} " + formats.date(transaction.bookingDate)
        return ValueRow(transaction.title, subtitle: subtitle) {
            AmountText(transaction.amount, transaction.currency, tone: .signed)
            Button("Restore") { Task { await restore(transaction) } }
                .font(.caption)
                .buttonStyle(.borderless)
                .disabled(store.busy)
        }
    }

    // MARK: Manual matching

    private var candidatesCollapsed: Bool {
        let settled = bill.status == "paid" || bill.status == "cancelled"
        return settled && !showCandidates && page.candidateQuery.isEmpty
    }

    @ViewBuilder
    private var candidatesSection: some View {
        Section {
            if candidatesCollapsed {
                Text(bill.status == "cancelled" ? "This bill is cancelled." : "This bill is fully paid.")
                    .foregroundStyle(.secondary)
                Button("Show anyway") { showCandidates = true }
            } else {
                candidateSearchField
                candidateRows
                candidatePaging
            }
        } header: {
            Text("Match a payment manually")
        } footer: {
            Text("Pick a transaction and choose how much of it pays this bill. A negative amount records a refund.")
        }
    }

    private var candidateSearchField: some View {
        TextField("Search counterparty, description, reference or amount", text: $candidateSearch)
            .submitLabel(.search)
            .autocorrectionDisabled()
            .onSubmit { Task { await searchCandidates() } }
    }

    @ViewBuilder
    private var candidateRows: some View {
        if page.candidates.items.isEmpty {
            if page.candidateQuery.isEmpty {
                Text("No unmatched \(bill.currency) transactions to offer for this bill.").foregroundStyle(.secondary)
            } else {
                Text("No transactions match \"\(page.candidateQuery)\".").foregroundStyle(.secondary)
            }
        }
        ForEach(page.candidates.items) { candidate in
            Button {
                allocating = candidate
            } label: {
                candidateRow(candidate)
            }
            .tint(.primary)
        }
    }

    private func candidateRow(_ candidate: BillCandidate) -> some View {
        let subtitle = candidate.accountName + " \u{00B7} " + formats.date(candidate.bookingDate)
        let partial = abs(candidate.unallocated) != abs(candidate.amount)
        return ValueRow(candidate.title, subtitle: subtitle) {
            AmountText(candidate.amount, candidate.currency, tone: .signed)
            if partial {
                HStack(spacing: 4) {
                    AmountText(abs(candidate.unallocated), candidate.currency)
                    Text("unallocated")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var candidatePaging: some View {
        if page.candidates.pageCount > 1 {
            HStack {
                Button("Previous") { Task { await goToCandidatePage(page.candidates.page - 1) } }
                    .disabled(page.candidates.page <= 1)
                    .buttonStyle(.borderless)
                Spacer()
                Text("Page \(page.candidates.page) of \(page.candidates.pageCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Next") { Task { await goToCandidatePage(page.candidates.page + 1) } }
                    .disabled(page.candidates.page >= page.candidates.pageCount)
                    .buttonStyle(.borderless)
            }
        }
    }

    // MARK: Edit sheet

    private var editSheet: some View {
        FormSheet("Edit bill", busy: store.busy, error: store.formErrors["form"]) {
            let result = await store.submit("update", form: editValues.formFields(documentId: nil))
            return result != nil
        } content: {
            if let editNote {
                Section { Text(editNote).font(.footnote) }
            }
            BillFormFields(
                values: $editValues,
                accounts: page.accounts,
                errors: store.formErrors,
                locked: bill.allocationCount > 0
            )
        }
    }

    private func openEdit() {
        editValues = BillFormValues.from(bill)
        editNote = nil
        store.formErrors = [:]
        editing = true
    }

    // MARK: Actions

    private func toggleCancel() async {
        await store.submit(bill.cancelled ? "uncancel" : "cancel", showRefusal: true)
    }

    private func deleteBill() async {
        let result = await store.submit("delete", showRefusal: true, reload: false)
        if result != nil {
            store.redirect = nil
            router.pop()
        }
    }

    private func reextract() async {
        guard let result = await store.submit("reextract", showRefusal: true, reload: false) else { return }
        do {
            let answer = try result.decode(BillReextractResult.self)
            guard let draft = answer.draft else {
                store.message = "The PDF could not be read again."
                return
            }
            editValues = BillFormValues.merged(
                BillFormValues.from(bill),
                with: draft,
                source: answer.extraction?.source,
                hasAllocations: bill.allocationCount > 0
            )
            editNote = "Values read from the PDF again. Nothing is saved until you press Save."
            store.formErrors = [:]
            editing = true
        } catch {
            store.message = "The PDF could not be read again."
        }
    }

    private func attach(_ document: BillPickedDocument) async {
        var form = FormFields()
        form.file("file", name: document.name, contentType: "application/pdf", data: document.data)
        await store.submit("attachDocument", form: form, showRefusal: true)
    }

    private func openDocument() async {
        openingDocument = true
        defer { openingDocument = false }
        do {
            let file = try await SDKClient.shared.download("bills/\(bill.id)/document")
            let name = BillText.safeFileName(file.fileName ?? page.document?.fileName ?? "bill.pdf")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try file.data.write(to: url, options: .atomic)
            preview = url
        } catch let error as KeptError {
            store.message = error.message
        } catch {
            store.message = "The document could not be opened."
        }
    }

    private func confirm(_ suggestion: BillSuggestion) async {
        let form = BillForms.confirm(
            billId: nil,
            transactionId: suggestion.transaction.id,
            amount: suggestion.amount,
            currency: bill.currency
        )
        await store.submit("allocate", form: form, showRefusal: true)
    }

    private func dismiss(_ suggestion: BillSuggestion) async {
        let form = BillForms.dismiss(billId: nil, transactionId: suggestion.transaction.id)
        await store.submit("dismissSuggestion", form: form, showRefusal: true)
    }

    private func restore(_ transaction: BillTransaction) async {
        await store.submit("undismiss", form: BillForms.transaction(transaction.id), showRefusal: true)
    }

    private func remove(_ allocation: BillDetailPage.Allocation) async {
        await store.submit("removeAllocation", form: BillForms.allocation(allocation.id), showRefusal: true)
    }

    private func searchCandidates() async {
        let text = candidateSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        store.query["q"] = text.isEmpty ? nil : text
        store.query["page"] = nil
        await store.load()
    }

    private func goToCandidatePage(_ number: Int) async {
        store.query["page"] = number <= 1 ? nil : String(number)
        await store.load()
    }
}

/// Choose how much of a transaction pays the bill.
private struct BillAllocateSheet: View {
    let store: PageStore<BillDetailPage>
    let candidate: BillCandidate
    let currency: String

    @State private var amount: String
    @Environment(\.formats) private var formats

    init(store: PageStore<BillDetailPage>, candidate: BillCandidate, currency: String) {
        self.store = store
        self.candidate = candidate
        self.currency = currency
        _amount = State(initialValue: Formats.amountInput(candidate.suggestedAmount, currency))
    }

    var body: some View {
        FormSheet("Match payment", busy: store.busy, error: store.formErrors["form"], submitLabel: "Allocate") {
            await submit()
        } content: {
            Section {
                ValueRow(candidate.title, subtitle: candidate.accountName + " \u{00B7} " + formats.date(candidate.bookingDate)) {
                    AmountText(candidate.amount, candidate.currency, tone: .signed)
                }
            }
            Section {
                AmountField(candidate.suggestedAmount < 0 ? "Refund amount (negative)" : "Amount to apply", text: $amount, currency: currency)
                FieldError(store.formErrors["amount"])
                FieldError(store.formErrors["transactionId"])
            } footer: {
                Text("A negative amount records money coming back for this bill.")
            }
        }
    }

    private func submit() async -> Bool {
        var form = FormFields()
        form.set("transactionId", candidate.id)
        form.set("amount", amount.trimmingCharacters(in: .whitespacesAndNewlines))
        let result = await store.submit("allocate", form: form)
        return result != nil
    }
}
