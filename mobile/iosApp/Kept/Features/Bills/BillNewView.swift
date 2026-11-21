import SwiftUI

/// Add a bill: optionally upload a document first (the server reads the QR-bill from it), then check the form and save.
struct BillNewView: View {
    @State private var store = PageStore<BillNewPage>(path: "bills/new")

    var body: some View {
        PageView("Add bill", store: store) { page in
            BillNewContent(store: store, page: page)
                .id(page.documentId ?? "none")
        }
    }
}

private struct BillNewContent: View {
    let store: PageStore<BillNewPage>
    let page: BillNewPage

    @State private var values: BillFormValues
    @State private var manual = false
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var showScanner = false
    @State private var uploading = false
    @State private var uploadError: String?
    @State private var currencyApplied = false
    @Environment(\.session) private var session

    init(store: PageStore<BillNewPage>, page: BillNewPage) {
        self.store = store
        self.page = page
        _values = State(initialValue: BillFormValues.from(draft: page.draft, currency: "CHF"))
    }

    private var showForm: Bool {
        manual || page.documentId != nil
    }

    var body: some View {
        List {
            if showForm {
                formSections
            } else {
                uploadSections
            }
        }
        .billDocumentSources(
            showFiles: $showFiles,
            showPhotos: $showPhotos,
            showScanner: $showScanner,
            onPicked: { document in Task { await upload(document) } },
            onFailed: { message in uploadError = message }
        )
        .onAppear { applyDefaultCurrency() }
    }

    private func applyDefaultCurrency() {
        guard !currencyApplied else { return }
        currencyApplied = true
        guard page.draft == nil, let currency = session?.preferences.defaultCurrency, !currency.isEmpty else { return }
        values.currency = currency
    }

    @ViewBuilder
    private var uploadSections: some View {
        Section {
            BillDocumentButtons(showFiles: $showFiles, showPhotos: $showPhotos, showScanner: $showScanner, disabled: uploading)
            if uploading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Reading the bill\u{2026}").foregroundStyle(.secondary)
                }
            }
            if let uploadError {
                Text(uploadError).font(.footnote).foregroundStyle(KeptColor.negative)
            }
        } header: {
            Text("Upload the bill")
        } footer: {
            Text("Kept reads the QR code of a Swiss QR-bill and fills the form for you. Nothing is saved until you check the values and save. Photos and scans are turned into a PDF (up to 20 MB). eBill: download the invoice PDF in your e-banking and upload it here.")
        }
        Section {
            Button {
                manual = true
            } label: {
                Label("Enter manually", systemImage: "pencil")
            }
        }
    }

    @ViewBuilder
    private var formSections: some View {
        sourceNotice
        BillFormFields(values: $values, accounts: page.accounts, errors: store.formErrors)
        Section {
            Button {
                Task { await save() }
            } label: {
                HStack {
                    Spacer()
                    if store.busy {
                        ProgressView()
                    } else {
                        Text("Save bill").fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(store.busy)
            if let message = store.formErrors["form"] {
                Text(message).font(.footnote).foregroundStyle(KeptColor.negative)
            }
            if let documentId = page.documentId, !documentId.isEmpty {
                Text("The uploaded PDF is attached when you save.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var sourceNotice: some View {
        let source = page.extraction?.source
        let warnings = page.extraction?.warnings ?? []
        if source != nil || !warnings.isEmpty {
            Section {
                if source == "qr" {
                    Label("Read from the QR code. Check the values, then save.", systemImage: "checkmark.circle")
                        .foregroundStyle(KeptColor.positive)
                } else if source == "text" {
                    Label("Guessed from the text. Please check every field.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(KeptColor.warning)
                } else if source == "none" {
                    Label(
                        "Nothing could be read from the PDF. Enter the details yourself; the PDF is kept with the bill.",
                        systemImage: "doc.text"
                    )
                }
                ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func save() async {
        let form = values.formFields(documentId: page.documentId)
        await store.submit("create", form: form, reload: false)
    }

    /// Sends the document to the `upload` action and reloads the page with the document the server stored.
    /// The action answers with a redirect to `/bills/new?document=<id>`; it is read here instead of followed,
    /// because following it would open a new page without the query.
    private func upload(_ document: BillPickedDocument) async {
        if uploading { return }
        uploading = true
        uploadError = nil
        defer { uploading = false }
        var form = FormFields()
        form.file("file", name: document.name, contentType: "application/pdf", data: document.data)
        do {
            let result = try await SDKClient.shared.action("bills/new", "upload", form: form)
            guard result.ok else {
                uploadError = result.fieldErrors["file"] ?? result.message ?? "The file could not be uploaded."
                return
            }
            guard let documentId = BillText.documentId(inRedirect: result.redirect) else {
                uploadError = "The server did not say where the document went. Try again."
                return
            }
            store.query["document"] = documentId
            await store.load()
        } catch let error as KeptError {
            uploadError = error.message
        } catch {
            uploadError = "The file could not be uploaded."
        }
    }
}
