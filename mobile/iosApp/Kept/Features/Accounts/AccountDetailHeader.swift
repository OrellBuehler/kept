import SwiftUI
import UIKit

/// Name, type, institution, website, IBAN, top-up IBAN and balance of the account.
struct AccountDetailHeader: View {
    let page: AccountPage

    @Environment(\.formats) private var formats
    @Environment(\.session) private var session
    @State private var copied = false
    @State private var topUpCopied = false

    private var account: AccountPage.Account { page.account }

    var body: some View {
        Section {
            identity
            websiteRow
            balanceRows
        }
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(account.name).font(.title2.weight(.semibold))
            pills
            if let institution = account.institution {
                Label(institution.name, systemImage: "building.columns")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ibanLine
            topUpLine
            if let contract = account.contractNumber, !contract.isEmpty {
                Text("Contract \(contract)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var pills: some View {
        HStack(spacing: 4) {
            Pill(AccountsLogic.typeLabel(account.type))
            if account.shareBps < AccountsLogic.fullShareBps {
                Pill("Shared \(AccountsLogic.shareText(account.shareBps))")
            }
            if let months = account.noticeMonths {
                Pill(noticeText(months))
            }
            if account.archived { Pill("Archived") }
        }
    }

    private func noticeText(_ months: Int) -> String {
        var text = months == 1 ? "1 month's notice" : "\(months) months' notice"
        if let free = account.freeWithdrawal, let period = account.freeWithdrawalPeriod {
            let amount = formats.money(free, account.currency)
            text += " \u{00B7} \(amount)/\(period) free"
        }
        return text
    }

    @ViewBuilder
    private var ibanLine: some View {
        let mode = session?.preferences.ibanDisplay ?? "full"
        if let iban = account.iban, let text = AccountsLogic.displayIban(iban, mode: mode) {
            HStack(spacing: 6) {
                Text(text).font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary)
                Button {
                    UIPasteboard.general.string = AccountsLogic.formatIban(iban)
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.footnote)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy IBAN")
            }
        }
    }

    @ViewBuilder
    private var topUpLine: some View {
        let mode = session?.preferences.ibanDisplay ?? "full"
        if account.type != "pillar_3a", let iban = account.depositIban, let text = AccountsLogic.displayIban(iban, mode: mode) {
            HStack(spacing: 6) {
                Text("Top up via").font(.footnote).foregroundStyle(.secondary)
                Text(text).font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary)
                Button {
                    UIPasteboard.general.string = AccountsLogic.formatIban(iban)
                    topUpCopied = true
                } label: {
                    Image(systemName: topUpCopied ? "checkmark" : "doc.on.doc").font(.footnote)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(topUpCopied ? "Top-up IBAN copied" : "Copy top-up IBAN")
            }
        }
    }

    @ViewBuilder
    private var websiteRow: some View {
        if let url = AccountsLogic.portalURL(own: account.websiteUrl, institution: account.institution?.websiteUrl) {
            Link(destination: url) {
                Label("Website", systemImage: "arrow.up.right.square")
            }
        }
    }

    @ViewBuilder
    private var balanceRows: some View {
        let currency = account.currency
        VStack(alignment: .leading, spacing: 2) {
            Text(page.value == nil ? "Current balance" : "Total").font(.caption).foregroundStyle(.secondary)
            AmountText(page.balance, currency, tone: .negative).font(.largeTitle.weight(.semibold))
        }
        if let valuation = page.value {
            LabeledContent("Cash") { AmountText(valuation.cash, currency) }
            if page.hasHoldings {
                LabeledContent("Holdings") { AmountText(valuation.holdings, currency) }
            }
            if page.showPortfolios {
                LabeledContent("Portfolios") { AmountText(valuation.portfolios, currency) }
            }
            if page.hasHoldings && valuation.estimated {
                Text("Estimated: no exchange rate for some holdings.").font(.caption).foregroundStyle(.secondary)
            }
        }
        if account.shareBps < AccountsLogic.fullShareBps {
            LabeledContent("My share") {
                AmountText(AccountsLogic.shareOf(page.balance, account.shareBps), currency)
            }
        }
    }
}
