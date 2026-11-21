import QuickLook
import SwiftUI

/// One tax year: the reconciliation of your payments with the tax office's statement, and the deductions.
struct TaxYearView: View {
    let year: String

    @State private var store: PageStore<TaxYearPage>
    @State private var tab = "reconciliation"
    @State private var preview: URL?
    @State private var addingCredit = false
    @State private var editingDetails = false
    @State private var deletingCredit: TaxYearPage.Credit?
    @State private var confirmDeleteYear = false
    @Environment(Router.self) private var router

    init(year: String) {
        self.year = year
        _store = State(initialValue: PageStore<TaxYearPage>(path: "taxes/\(year)"))
    }

    var body: some View {
        PageView("Tax \(year)", store: store) { page in
            content(page)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        Task { await openReport("tax") }
                    } label: {
                        Label("Tax report (PDF)", systemImage: "doc.text")
                    }
                    Button {
                        Task { await openReport("tax-deductions") }
                    } label: {
                        Label("Deductions report (PDF)", systemImage: "doc.text")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Reports")
            }
        }
        .quickLookPreview($preview)
        .sheet(isPresented: $addingCredit) {
            creditSheet
        }
        .sheet(isPresented: $editingDetails) {
            detailsSheet
        }
        .confirmationDialog(
            "Delete this statement line?",
            isPresented: creditBinding,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let credit = deletingCredit {
                    Task { await deleteCredit(credit) }
                }
            }
        } message: {
            Text("The line of the tax office's statement is removed.")
        }
        .confirmationDialog(
            "Delete the details of tax year \(year)?",
            isPresented: $confirmDeleteYear,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                Task { await deleteYear() }
            }
        } message: {
            Text("The authority, assessed total and the tax office's statement lines are removed. Transactions and bills you tagged with this year keep their tag.")
        }
    }

    private var creditBinding: Binding<Bool> {
        Binding(
            get: { deletingCredit != nil },
            set: { value in
                if !value { deletingCredit = nil }
            }
        )
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ page: TaxYearPage) -> some View {
        List {
            Section {
                Picker("View", selection: $tab) {
                    Text("Reconciliation").tag("reconciliation")
                    Text("Deductions").tag("deductions")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if page.deductionMoves > 0 {
                movesSection(page.deductionMoves)
            }
            if tab == "reconciliation" {
                TaxReconciliationSections(
                    store: store,
                    page: page,
                    onAddCredit: { addingCredit = true },
                    onEditDetails: { editingDetails = true },
                    onDeleteCredit: { credit in deletingCredit = credit },
                    onDeleteYear: { confirmDeleteYear = true }
                )
            } else {
                TaxDeductionsSections(store: store, page: page)
            }
        }
    }

    @ViewBuilder
    private func movesSection(_ count: Int) -> some View {
        Section {
            Button("Review") { tab = "deductions" }
            Button("Undo") {
                Task { await store.submit("undoDeductionMoves", showRefusal: true) }
            }
            Button("Dismiss") {
                Task { await store.submit("dismissDeductionMoves", showRefusal: true) }
            }
        } header: {
            Text("Reclassified during the update")
        } footer: {
            Text(count == 1
                ? "1 transaction was moved from tax payment to deduction year."
                : "\(count) transactions were moved from tax payment to deduction year.")
        }
    }

    // MARK: Sheets

    @ViewBuilder
    private var creditSheet: some View {
        if let details = store.state.value?.reconciliation.year {
            TaxCreditSheet(store: store, currency: details.currency)
        }
    }

    @ViewBuilder
    private var detailsSheet: some View {
        if let details = store.state.value?.reconciliation.year {
            TaxDetailsSheet(
                store: store,
                title: "Details",
                submitLabel: "Save",
                action: "saveDetails",
                fixedYear: String(details.year),
                initialYear: String(details.year),
                authority: details.authority ?? "",
                currency: details.currency,
                assessedTotal: assessedInput(details),
                notes: details.notes ?? ""
            )
        }
    }

    private func assessedInput(_ details: TaxYearPage.Details) -> String {
        guard let total = details.assessedTotal else { return "" }
        return Formats.amountInput(total, details.currency)
    }

    // MARK: Actions

    private func deleteCredit(_ credit: TaxYearPage.Credit) async {
        await store.submit("deleteCredit", form: FormFields(["creditId": credit.id]), showRefusal: true)
    }

    private func deleteYear() async {
        do {
            let result = try await SDKClient.shared.action(store.path, "deleteYear")
            if result.ok {
                router.pop()
            } else {
                store.message = result.message ?? "The tax year could not be deleted."
            }
        } catch let error as KeptError {
            store.message = error.message
        } catch {
            store.message = error.localizedDescription
        }
    }

    private func openReport(_ kind: String) async {
        do {
            let file = try await SDKClient.shared.download("reports/\(kind)", query: ["year": year])
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(kind)-\(year).pdf")
            try file.data.write(to: url)
            preview = url
        } catch let error as KeptError {
            store.message = error.message
        } catch {
            store.message = error.localizedDescription
        }
    }
}
