import SwiftUI

/// What you paid against what the tax office counted, year by year.
struct TaxesView: View {
    @State private var store = PageStore<TaxesPage>(path: "taxes")
    @State private var adding = false
    @State private var appeared = false
    @Environment(\.formats) private var formats

    var body: some View {
        PageView("Taxes", store: store) { page in
            content(page)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    adding = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add tax year")
            }
        }
        .sheet(isPresented: $adding) {
            addSheet
        }
        .onAppear {
            // Coming back from a year (it may have been deleted): the first appearance loads through the page view.
            if appeared { Task { await store.load() } }
            appeared = true
        }
    }

    @ViewBuilder
    private var addSheet: some View {
        let page = store.state.value
        TaxDetailsSheet(
            store: store,
            title: "Add a tax year",
            submitLabel: "Add",
            action: "create",
            fixedYear: nil,
            initialYear: String(page?.defaultYear ?? 2025),
            authority: "",
            currency: page?.defaultCurrency ?? "CHF",
            assessedTotal: "",
            notes: ""
        )
    }

    @ViewBuilder
    private func content(_ page: TaxesPage) -> some View {
        List {
            Section {
                if page.years.isEmpty {
                    Text("No tax years yet. Add a year, or mark a transaction as a tax payment from its account.")
                        .foregroundStyle(.secondary)
                }
                ForEach(page.years) { year in
                    NavigationLink(value: Route.taxYear(String(year.year))) {
                        TaxesYearRow(year: year)
                    }
                }
            } footer: {
                Text("Compare what you paid with what the tax office counted. Payments count once you mark a transaction, or a bill, with its tax year.")
            }
        }
    }
}

private struct TaxesYearRow: View {
    let year: TaxesPage.Year

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(String(year.year)).font(.headline).monospacedDigit()
                if let authority = year.authority, !authority.isEmpty {
                    Text(authority).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                status
            }
            HStack(alignment: .top) {
                figure("Paid by you") {
                    AmountText(year.balance.paidByMe, year.currency)
                }
                figure("Counted") {
                    AmountText(year.balance.creditedByOffice, year.currency)
                }
                figure("Open") {
                    TaxOutcomeText(balance: year.balance, currency: year.currency)
                }
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var status: some View {
        if year.reconciled {
            Pill("Reconciled", color: KeptColor.positive)
        } else if year.discrepancies > 0 {
            Pill(TaxText.differencesText(year.discrepancies), color: KeptColor.negative)
        } else {
            Pill("No lines")
        }
    }

    private func figure<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content().font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Due CHF 210.00", "Refund CHF 50.00", "Settled" or "No assessment".
struct TaxOutcomeText: View {
    let balance: TaxBalance
    let currency: String

    var body: some View {
        if let amount = TaxText.outcomeAmount(balance) {
            VStack(alignment: .leading, spacing: 0) {
                Text(TaxText.outcomeLabel(balance))
                    .font(.caption)
                    .foregroundStyle(balance.outcome == "refund" ? KeptColor.positive : Color.primary)
                AmountText(amount, currency, tone: balance.outcome == "refund" ? .signed : .plain)
            }
        } else {
            Text(TaxText.outcomeLabel(balance)).foregroundStyle(.secondary)
        }
    }
}
