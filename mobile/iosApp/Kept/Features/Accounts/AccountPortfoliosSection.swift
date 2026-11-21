import SwiftUI
import UIKit

/// The portfolios of a pillar 3a account: their latest values, deposit details, and the ways to change them.
struct AccountPortfoliosSection: View {
    let store: PageStore<AccountPage>
    let page: AccountPage
    @Binding var sheet: AccountDetailSheet?
    @Binding var confirm: AccountDetailConfirm?

    @Environment(\.formats) private var formats
    @Environment(\.session) private var session

    private var openPortfolios: [AccountPage.Portfolio] { page.portfolios.filter { $0.closedOn == nil } }
    private var closedPortfolios: [AccountPage.Portfolio] { page.portfolios.filter { $0.closedOn != nil } }

    var body: some View {
        openSection
        if !closedPortfolios.isEmpty { closedSection }
        if page.account.depositIban != nil || page.account.contractNumber != nil { depositSection }
    }

    private var openSection: some View {
        Section {
            if page.portfolios.isEmpty {
                Text("No portfolios. Add each portfolio of this contract with its payment reference, then record its value from time to time.")
                    .foregroundStyle(.secondary)
            }
            ForEach(openPortfolios) { portfolio in
                row(portfolio)
            }
            if !openPortfolios.isEmpty {
                Button {
                    sheet = .portfolioValues
                } label: {
                    Label("Update values", systemImage: "arrow.clockwise")
                }
            }
            Button {
                sheet = .addPortfolio
            } label: {
                Label("Add portfolio", systemImage: "plus")
            }
        } header: {
            Text("Portfolios")
        } footer: {
            Text("Each portfolio is valued by hand from your provider's statement. Their values are added to the cash balance of this account.")
        }
    }

    private var closedSection: some View {
        Section("Closed portfolios") {
            ForEach(closedPortfolios) { portfolio in
                row(portfolio)
            }
        }
    }

    private func subtitle(_ portfolio: AccountPage.Portfolio) -> String {
        var lines: [String] = []
        var first: [String] = []
        if let strategy = portfolio.strategy, !strategy.isEmpty { first.append(strategy) }
        if let number = portfolio.number, !number.isEmpty { first.append("No. \(number)") }
        if !first.isEmpty { lines.append(first.joined(separator: " \u{00B7} ")) }
        if let reason = portfolio.closeReason { lines.append(AccountsLogic.closeReasonLabel(reason)) }
        if let reference = portfolio.depositReference, !reference.isEmpty {
            lines.append(AccountsLogic.formatReference(reference))
        }
        return lines.joined(separator: "\n")
    }

    private func row(_ portfolio: AccountPage.Portfolio) -> some View {
        Button {
            sheet = .portfolioHistory(portfolio.id)
        } label: {
            ValueRow(portfolio.name, subtitle: subtitle(portfolio)) {
                if let value = portfolio.latestValue {
                    AmountText(value, page.account.currency).font(.headline)
                    if let date = portfolio.latestValueDate {
                        Text("as of \(formats.date(date))").font(.caption2).foregroundStyle(.secondary)
                    }
                } else {
                    Text("No value yet").font(.caption).foregroundStyle(.secondary)
                }
                if let closed = portfolio.closedOn {
                    Pill("Closed \(formats.date(closed))")
                }
            }
        }
        .tint(.primary)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                confirm = AccountDetailConfirm(
                    action: "deletePortfolio",
                    field: "portfolioId",
                    targetId: portfolio.id,
                    title: "Delete \(portfolio.name)?",
                    message: "This is only possible while the portfolio has no values and no contributions. Close it instead to keep its history.",
                    button: "Delete"
                )
            } label: {
                Label("Delete", systemImage: "trash")
            }
            if portfolio.closedOn == nil {
                Button {
                    sheet = .closePortfolio(portfolio.id)
                } label: {
                    Label("Close", systemImage: "lock")
                }
                .tint(.orange)
            } else {
                Button {
                    Task { await reopen(portfolio) }
                } label: {
                    Label("Reopen", systemImage: "arrow.uturn.backward")
                }
                .tint(.orange)
            }
            Button {
                sheet = .editPortfolio(portfolio.id)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            .tint(.blue)
        }
    }

    private func reopen(_ portfolio: AccountPage.Portfolio) async {
        var form = FormFields()
        form.set("portfolioId", portfolio.id)
        await store.submit("reopenPortfolio", form: form, showRefusal: true)
    }

    private var depositSection: some View {
        Section {
            if let contract = page.account.contractNumber, !contract.isEmpty {
                LabeledContent("Contract number") { Text(contract).font(.system(.footnote, design: .monospaced)) }
            }
            if let deposit = page.account.depositIban {
                depositRow(deposit)
            }
        } header: {
            Text("Deposit details")
        } footer: {
            Text("Use these to pay into a portfolio: the IBAN, plus the portfolio's own reference above.")
        }
    }

    private func depositRow(_ deposit: String) -> some View {
        let mode = session?.preferences.ibanDisplay ?? "full"
        let label = AccountsLogic.isQrIban(deposit) ? "QR-IBAN" : "IBAN"
        return LabeledContent(label) {
            HStack(spacing: 6) {
                if let text = AccountsLogic.displayIban(deposit, mode: mode) {
                    Text(text).font(.system(.footnote, design: .monospaced)).multilineTextAlignment(.trailing)
                } else {
                    Text("Hidden").foregroundStyle(.secondary)
                }
                Button {
                    UIPasteboard.general.string = AccountsLogic.formatIban(deposit)
                } label: {
                    Image(systemName: "doc.on.doc").font(.footnote)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy deposit IBAN")
            }
        }
    }
}
