import SwiftUI
import UniformTypeIdentifiers

struct ImportPickedFile: Sendable {
    let name: String
    let data: Data
}

/// Upload a statement: pick the account and the file, then review it.
struct ImportView: View {
    @State private var store = PageStore<ImportPage>(path: "import")
    @State private var accountId = ""
    @State private var picked: ImportPickedFile?
    @State private var picking = false
    @State private var fileError: String?

    @Environment(Router.self) private var router
    @Environment(\.formats) private var formats

    var body: some View {
        PageView("Import", store: store) { page in
            List {
                if page.accounts.isEmpty {
                    noAccounts()
                } else {
                    uploadSection(page)
                }
                if page.inbox.enabled {
                    inboxSection(page.inbox)
                }
                recentSection(page.recentImports)
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: Self.contentTypes()) { result in
            pick(result)
        }
    }

    private static func contentTypes() -> [UTType] {
        var types: [UTType] = [.xml, .commaSeparatedText, .plainText]
        for ext in ["xlsx", "sta", "mt940", "940"] {
            if let type = UTType(filenameExtension: ext) { types.append(type) }
        }
        return types
    }

    private func effectiveAccount(_ page: ImportPage) -> String {
        if !accountId.isEmpty { return accountId }
        if let selected = page.selectedAccountId { return selected }
        if page.accounts.count == 1 { return page.accounts[0].id }
        return ""
    }

    @ViewBuilder
    private func noAccounts() -> some View {
        Section {
            ContentUnavailableView {
                Label("No accounts to import into", systemImage: "building.columns")
            } description: {
                Text("Create an account first, then upload a statement for it.")
            } actions: {
                Button("Go to accounts") { router.tab = .accounts }
            }
        }
    }

    @ViewBuilder
    private func uploadSection(_ page: ImportPage) -> some View {
        Section {
            Picker("Account", selection: accountBinding(page)) {
                Text("Choose an account").tag("")
                ForEach(page.accounts) { account in
                    Text(accountLabel(account)).tag(account.id)
                }
            }
            FieldError(store.formErrors["accountId"])
            fileRow()
            FieldError(fileError ?? store.formErrors["file"])
            FieldError(store.formErrors["form"])
            Button {
                Task { await upload(page) }
            } label: {
                if store.busy {
                    ProgressView()
                } else {
                    Label("Upload and review", systemImage: "square.and.arrow.up")
                }
            }
            .disabled(store.busy || picked == nil || effectiveAccount(page).isEmpty)
        } header: {
            Text("Upload a statement")
        } footer: {
            Text("ISO 20022 camt.053 or camt.054 XML, SWIFT MT940, CSV or Excel exports, up to 20 MB. For CSV and Excel you map the columns once per account; the mapping is remembered.")
        }
    }

    private func accountBinding(_ page: ImportPage) -> Binding<String> {
        Binding(
            get: { effectiveAccount(page) },
            set: { accountId = $0 }
        )
    }

    private func accountLabel(_ account: ImportPage.Account) -> String {
        var label = "\(account.name) (\(account.currency))"
        if let institution = account.institutionName, !institution.isEmpty {
            label += " · \(institution)"
        }
        return label
    }

    @ViewBuilder
    private func fileRow() -> some View {
        Button {
            picking = true
        } label: {
            HStack {
                Image(systemName: "doc.text")
                if let picked {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(picked.name).lineLimit(1)
                        Text(ImportText.bytes(picked.data.count)).font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text("Choose a file")
                }
                Spacer()
                Text(picked == nil ? "Browse" : "Change").foregroundStyle(Color.accentColor)
            }
        }
    }

    private func pick(_ result: Result<URL, Error>) {
        fileError = nil
        switch result {
        case let .failure(error):
            fileError = error.localizedDescription
        case let .success(url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url)
                if data.count > ImportText.maxUploadBytes {
                    fileError = "This file is \(ImportText.bytes(data.count)); the limit is 20 MB."
                    picked = nil
                } else if data.isEmpty {
                    fileError = "The file is empty."
                    picked = nil
                } else {
                    picked = ImportPickedFile(name: url.lastPathComponent, data: data)
                }
            } catch {
                fileError = "The file could not be read."
                picked = nil
            }
        }
    }

    private func upload(_ page: ImportPage) async {
        guard let picked else {
            fileError = "Choose a file to upload."
            return
        }
        let account = effectiveAccount(page)
        if account.isEmpty { return }
        var form = FormFields()
        form.set("accountId", account)
        form.file(
            "file",
            name: picked.name,
            contentType: ImportText.contentType(forFileName: picked.name),
            data: picked.data
        )
        await store.submit("upload", form: form, reload: false)
    }

    // MARK: Watch folder

    @ViewBuilder
    private func inboxSection(_ inbox: ImportPage.Inbox) -> some View {
        Section {
            if inbox.entries.isEmpty {
                Text("Nothing picked up from the inbox yet.").foregroundStyle(.secondary)
            }
            ForEach(inbox.entries) { entry in
                inboxRow(entry)
            }
        } header: {
            Text("Watch folder")
        } footer: {
            Text(inboxFooter(inbox))
        }
    }

    private func inboxFooter(_ inbox: ImportPage.Inbox) -> String {
        let intro = "Files dropped into your inbox folder are imported automatically when they match one of your accounts and the preview has no warnings."
        if let scan = inbox.lastScan {
            return intro + " Last scan: " + ImportText.dateTime(scan.at, locale: formats.locale) + "."
        }
        return intro + " No scan has run yet."
    }

    private func inboxStatusLabel(_ status: String) -> String {
        switch status {
        case "imported": return "Imported"
        case "review": return "Needs review"
        case "failed": return "Failed"
        default: return "Already imported"
        }
    }

    private func inboxStatusColor(_ status: String) -> Color {
        switch status {
        case "imported": return KeptColor.positive
        case "review": return KeptColor.warning
        case "failed": return KeptColor.negative
        default: return .secondary
        }
    }

    private func inboxDetail(_ entry: ImportPage.InboxEntry) -> String {
        var parts: [String] = []
        if let account = entry.accountName { parts.append(account) }
        if entry.status == "imported" {
            parts.append("\(entry.newCount ?? 0) new · \(entry.duplicateCount ?? 0) duplicate")
        } else if let reason = entry.reason {
            parts.append(reason)
        }
        parts.append(ImportText.dateTime(entry.updatedAt, locale: formats.locale))
        return parts.joined(separator: "\n")
    }

    @ViewBuilder
    private func inboxRow(_ entry: ImportPage.InboxEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(entry.fileName).lineLimit(1)
                Spacer(minLength: 8)
                Pill(inboxStatusLabel(entry.status), color: inboxStatusColor(entry.status))
            }
            Text(inboxDetail(entry)).font(.caption).foregroundStyle(.secondary)
            if entry.status == "review" {
                Button("Review") {
                    Task {
                        await store.submit(
                            "reviewInbox",
                            form: FormFields(["entryId": entry.id]),
                            showRefusal: true,
                            reload: false
                        )
                    }
                }
                .buttonStyle(.bordered)
                .disabled(store.busy)
            }
        }
    }

    // MARK: Recent

    @ViewBuilder
    private func recentSection(_ recent: [ImportPage.Recent]) -> some View {
        Section("Recent imports") {
            if recent.isEmpty {
                Text("No imports yet. Completed imports show up here.").foregroundStyle(.secondary)
            }
            ForEach(recent) { item in
                NavigationLink(value: Route.accountImports(item.accountId)) {
                    recentRow(item)
                }
            }
        }
    }

    private func recentDetail(_ item: ImportPage.Recent) -> String {
        let period = ImportText.period(item.statementFrom, item.statementTo, formats: formats)
        let counts = "\(item.newCount) new · \(item.duplicateCount) duplicate"
        return item.accountName + "\n" + period + "\n" + counts
    }

    @ViewBuilder
    private func recentRow(_ item: ImportPage.Recent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.fileName).lineLimit(1)
                Pill(ImportText.formatLabel(item.format))
                if !item.warnings.isEmpty {
                    Pill(ImportText.plural(item.warnings.count, "warning"), color: KeptColor.warning)
                }
            }
            Text(recentDetail(item)).font(.caption).foregroundStyle(.secondary)
            Text(ImportText.dateTime(item.createdAt, locale: formats.locale))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}
