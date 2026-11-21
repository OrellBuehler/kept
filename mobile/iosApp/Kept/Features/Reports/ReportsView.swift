import Observation
import QuickLook
import SwiftUI

/// Downloads a PDF report and hands it to Quick Look, which also offers sharing.
@MainActor
@Observable
final class ReportsModel {
    /// The report being generated ("statement", "bills", ...); nil when idle.
    var generating: String?
    var message: String?
    var preview: URL?

    func generate(_ kind: String, query: [String: String] = [:]) async {
        if generating != nil { return }
        generating = kind
        defer { generating = nil }
        do {
            let file = try await SDKClient.shared.download("reports/\(kind)", query: query)
            let name = ReportsLogic.safeFileName(file.fileName, kind: kind)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try file.data.write(to: url, options: .atomic)
            preview = url
        } catch let error as KeptError {
            message = error.message
        } catch is CancellationError {
            // The screen went away; nothing to show.
        } catch {
            message = "The report could not be saved on this device."
        }
    }
}

/// PDF reports to keep or share.
struct ReportsView: View {
    @State private var store = PageStore<ReportsPage>(path: "reports")
    @State private var model = ReportsModel()

    var body: some View {
        PageView("Reports", store: store) { page in
            ReportsOptions(page: page, model: model)
        }
        .messageAlert(Binding(get: { model.message }, set: { model.message = $0 }))
        .quickLookPreview(Binding(get: { model.preview }, set: { model.preview = $0 }))
    }
}

/// The forms of the report kinds.
struct ReportsOptions: View {
    let page: ReportsPage
    let model: ReportsModel
    @Environment(Router.self) private var router

    @State private var showArchived = false
    @State private var accountId: String
    @State private var from: String
    @State private var to: String
    @State private var taxYear: Int

    init(page: ReportsPage, model: ReportsModel) {
        self.page = page
        self.model = model
        let range = ReportsLogic.lastFullMonth(today: page.today)
        let open = ReportsLogic.visible(page.accounts, showArchived: false)
        _accountId = State(initialValue: open.count == 1 ? open[0].id : "")
        _from = State(initialValue: range.from)
        _to = State(initialValue: range.to)
        let years = ReportsLogic.taxYears(today: page.today)
        _taxYear = State(initialValue: years.count > 1 ? years[1] : years[0])
    }

    var body: some View {
        List {
            statementSection
            billsSection
            netWorthSection
            taxSection
            taxDeductionsSection
        }
    }

    private var busy: Bool { model.generating != nil }

    private var visibleAccounts: [ReportsPage.Account] {
        ReportsLogic.visible(page.accounts, showArchived: showArchived)
    }

    private var statementReady: Bool {
        let known = visibleAccounts.contains { $0.id == accountId }
        return known && ReportsLogic.canDownloadStatement(accountId: accountId, from: from, to: to)
    }

    private func downloadLabel(_ kind: String, _ title: String) -> some View {
        HStack {
            Label(title, systemImage: "arrow.down.doc")
            Spacer()
            if model.generating == kind { ProgressView() }
        }
    }

    // MARK: Statement

    private var statementSection: some View {
        Section {
            if page.accounts.isEmpty {
                emptyAccounts
            } else {
                statementFields
            }
        } header: {
            Text("Account statement")
        } footer: {
            Text("Opening and closing balance and every transaction of one account in a period.")
        }
    }

    private var emptyAccounts: some View {
        ContentUnavailableView {
            Label("No accounts yet", systemImage: "building.columns")
        } description: {
            Text("Add an account to generate a statement for it.")
        } actions: {
            Button("Go to accounts") { router.tab = .accounts }
                .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    private var statementFields: some View {
        Picker("Account", selection: $accountId) {
            Text("Choose an account").tag("")
            ForEach(visibleAccounts) { account in
                Text(ReportsLogic.accountLabel(account)).tag(account.id)
            }
        }
        Toggle("Show archived accounts", isOn: $showArchived)
        DateField("From", value: $from)
        DateField("To", value: $to)
        if !from.isEmpty && !to.isEmpty && from > to {
            FieldError("The end date must not be before the start date.")
        }
        Button {
            let query = ["account": accountId, "from": from, "to": to]
            Task { await model.generate("statement", query: query) }
        } label: {
            downloadLabel("statement", "Download PDF")
        }
        .disabled(busy || !statementReady)
    }

    // MARK: Bills, net worth

    private var billsSection: some View {
        Section {
            Button {
                Task { await model.generate("bills") }
            } label: {
                downloadLabel("bills", "Download PDF")
            }
            .disabled(busy)
        } header: {
            Text("Bills")
        } footer: {
            Text("All bills with their status, amounts and due dates.")
        }
    }

    private var netWorthSection: some View {
        Section {
            Button {
                Task { await model.generate("net-worth") }
            } label: {
                downloadLabel("net-worth", page.hasShared ? "Download PDF (total)" : "Download PDF")
            }
            .disabled(busy)
            if page.hasShared {
                Button {
                    Task { await model.generate("net-worth", query: ["basis": "share"]) }
                } label: {
                    downloadLabel("net-worth", "Download PDF (my share)")
                }
                .disabled(busy)
            }
        } header: {
            Text("Net worth")
        } footer: {
            Text(netWorthNote)
        }
    }

    private var netWorthNote: String {
        var text = "Current balances per account and net worth over time, per currency."
        if page.hasShared { text += " Shared accounts are counted in full, or at your share." }
        return text
    }

    // MARK: Tax

    private var yearPicker: some View {
        Picker("Tax year", selection: $taxYear) {
            ForEach(ReportsLogic.taxYears(today: page.today), id: \.self) { year in
                Text(String(year)).tag(year)
            }
        }
    }

    private var taxSection: some View {
        Section {
            yearPicker
            Button {
                Task { await model.generate("tax", query: ["year": String(taxYear)]) }
            } label: {
                downloadLabel("tax", "Download PDF")
            }
            .disabled(busy)
        } header: {
            Text("Tax report")
        } footer: {
            Text("The tax report of the selected year.")
        }
    }

    private var taxDeductionsSection: some View {
        Section {
            Button {
                Task { await model.generate("tax-deductions", query: ["year": String(taxYear)]) }
            } label: {
                downloadLabel("tax-deductions", "Download PDF")
            }
            .disabled(busy)
        } header: {
            Text("Tax deductions")
        } footer: {
            Text("The deductions of the selected tax year. Reports reflect the data at the moment you download them.")
        }
    }
}
