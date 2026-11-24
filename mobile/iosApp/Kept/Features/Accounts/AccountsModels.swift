import Foundation

/// `GET pages/accounts`: every institution and account of the user. Amounts are minor units of
/// the account's currency.
struct AccountsPage: Decodable, Sendable {
    let institutions: [Institution]
    let accounts: [Account]

    struct Institution: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let bic: String?
        let color: String?
        let logoVersion: String?
        let websiteUrl: String?
        let accountCount: Int
    }

    struct Account: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let type: String
        let currency: String
        let iban: String?
        let contractNumber: String?
        let websiteUrl: String?
        let depositIban: String?
        let openingBalance: Int64
        let openingDate: String?
        let noticeMonths: Int?
        let freeWithdrawal: Int64?
        let freeWithdrawalPeriod: String?
        let fillFromTransfers: Bool
        let tradesMoveCash: Bool
        let archived: Bool
        let sortOrder: Int
        let shareBps: Int
        let sharedWith: String?
        let institution: InstitutionRef?
        let balance: Int64
        let cashBalance: Int64
        let holdings: Holdings?
        let shareBalance: Int64
        let lastBookingDate: String?
        let lastImportAt: Int64?
        let lastCheckedAt: Int64?

        struct Holdings: Decodable, Sendable {
            let value: Int64
            let cost: Int64
            let estimated: Bool
        }
    }
}

/// `GET pages/accounts/<id>`: one account with its transactions, holdings, portfolios, balance
/// snapshots and open transfer work. The query parameters of the web page (`q`, `from`, `to`,
/// `min`, `max`, `page`, `pageSize`) filter and page `transactions`.
struct AccountPage: Decodable, Sendable {
    typealias Account = AccountsPage.Account

    let account: Account
    let balance: Int64
    let value: Valuation?
    let hasHoldings: Bool
    let showPortfolios: Bool
    let portfolios: [Portfolio]
    let portfolioValues: [String: [PortfolioValue]]
    let trades: [Trade]
    let securities: [SecurityItem]
    let institutions: [InstitutionOption]
    let transactions: TxList
    let focused: Tx?
    let transactionLinks: [String: [ExternalLink]]
    let snapshots: [Snapshot]
    let transfers: Transfers
    let categories: [Category]
    let filters: Filters
    let filterErrors: [String: [String]]

    struct InstitutionOption: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
    }

    /// Cash, holdings and portfolios of an account that has any of the latter two.
    struct Valuation: Decodable, Sendable {
        let cash: Int64
        let holdings: Int64
        let portfolios: Int64
        let total: Int64
        let estimated: Bool
        let positions: [Position]
    }

    /// What is held of one security, valued at the latest price. Quantity and price are
    /// fixed-point integers scaled by 10^8.
    struct Position: Decodable, Sendable, Identifiable {
        let securityId: String
        let name: String
        let currency: String
        let quantity: Int64
        let price: Int64
        let priceDate: String?
        let priceSource: String
        let value: Int64
        let cost: Int64
        let gain: Int64
        let estimated: Bool
        var id: String { securityId }
    }

    /// A buy, sell or split. Quantity and price are scaled by 10^8; fees and amount are minor
    /// units of the account's currency. A split carries its exact terms in `splitNew : splitOld`.
    struct Trade: Decodable, Sendable, Identifiable {
        let id: String
        let securityId: String
        let securityName: String
        let securityCurrency: String
        let date: String
        let side: String
        let quantity: Int64
        let splitNew: Int64?
        let splitOld: Int64?
        let price: Int64
        let fees: Int64
        let amount: Int64
        let note: String?
    }

    struct SecurityItem: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let kind: String
        let isin: String?
        let symbol: String?
        let currency: String
    }

    struct Portfolio: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let number: String?
        let strategy: String?
        let depositReference: String?
        let openedOn: String?
        let closedOn: String?
        let closeReason: String?
        let sortOrder: Int
        let latestValue: Int64?
        let latestValueDate: String?
        let latestGain: Int64?
        let latestGainBps: Int?
    }

    struct PortfolioValue: Decodable, Sendable, Identifiable {
        let id: String
        let portfolioId: String
        let date: String
        let amount: Int64
        let gain: Int64?
        let gainBps: Int?
        let note: String?
    }

    struct Snapshot: Decodable, Sendable, Identifiable {
        let id: String
        let date: String
        let amount: Int64
        let source: String
        let note: String?
    }

    struct Category: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let parentId: String?
        let kind: String
        let color: String?
        let icon: String?
    }

    struct Filters: Decodable, Sendable {
        let from: String
        let to: String
        let q: String
        let min: String
        let max: String

        var isActive: Bool {
            return !from.isEmpty || !to.isEmpty || !q.isEmpty || !min.isEmpty || !max.isEmpty
        }
    }

    struct ExternalLink: Decodable, Sendable, Identifiable {
        let id: String
        let label: String
        let url: String
        let source: String
    }

    struct TxList: Decodable, Sendable {
        let items: [Tx]
        let page: Int
        let pageCount: Int
        let pageSize: Int
        let total: Int
    }

    /// One transaction. `source` is "manual", "import" or "mirror" (created by Kept from a
    /// transfer on another account).
    struct Tx: Decodable, Sendable, Identifiable {
        let id: String
        let accountId: String
        let source: String
        let bookingDate: String
        let valueDate: String?
        let amount: Int64
        let currency: String
        let originalAmount: Int64?
        let originalCurrency: String?
        let counterpartyName: String?
        let counterpartyIban: String?
        let description: String?
        let reference: String?
        let referenceType: String?
        let reversal: Bool
        let note: String?
        let categoryId: String?
        let taxYear: Int?
        let deductionYear: Int?
        let mirrorOf: MirrorOf?
        let transfer: TransferLink?

        struct MirrorOf: Decodable, Sendable {
            let accountId: String
            let accountName: String
            let transactionId: String
            let noBankCounterpart: Bool
        }

        /// `direction` is "out" or "in", `status` "linked", "needs_amount" or "dismissed",
        /// `method` "paired", "mirrored" or "manual".
        struct TransferLink: Decodable, Sendable {
            let id: String
            let direction: String
            let method: String
            let status: String
            let peerAccountId: String
            let peerAccountName: String
            let peerTransactionId: String?
        }
    }

    struct Transfers: Decodable, Sendable {
        let mirrorCount: Int
        let fillSuggestion: FillSuggestion?
        let needsAmount: [NeedsAmount]

        struct FillSuggestion: Decodable, Sendable {
            let count: Int
        }
    }

    /// A transfer in another currency that waits for the amount this account booked.
    struct NeedsAmount: Decodable, Sendable, Identifiable {
        let transferId: String
        let sourceTransactionId: String
        let sourceAccountId: String
        let sourceAccountName: String
        let targetAccountId: String
        let targetAccountName: String
        let targetCurrency: String
        let direction: String
        let bookingDate: String
        let amount: Int64
        let currency: String
        let description: String?
        let linkCandidate: LinkCandidate?
        var id: String { transferId }

        struct LinkCandidate: Decodable, Sendable {
            let id: String
            let bookingDate: String
            let amount: Int64
            let currency: String
            let description: String?
        }
    }

    func transaction(withId id: String) -> Tx? {
        if let found = transactions.items.first(where: { $0.id == id }) { return found }
        if let focused, focused.id == id { return focused }
        return nil
    }

    func category(withId id: String?) -> Category? {
        guard let id else { return nil }
        return categories.first(where: { $0.id == id })
    }
}

/// The `data` of the action `transferCandidates`.
struct AccountTransferCandidates: Decodable, Sendable {
    let candidates: [Candidate]

    struct Candidate: Decodable, Sendable, Identifiable {
        let id: String
        let accountId: String
        let accountName: String
        let bookingDate: String
        let amount: Int64
        let currency: String
        let counterpartyName: String?
        let description: String?
        let exact: Bool
        let days: Int
    }
}

/// The `data` of the action `enableFillFromTransfers`.
struct AccountFillResult: Decodable, Sendable {
    let paired: Int
    let mirrored: Int
    let needsAmount: Int
}

/// `GET pages/accounts/<id>/imports`: the import history of an account.
struct AccountImportsPage: Decodable, Sendable {
    let account: AccountsPage.Account
    let imports: [Entry]
    let impacts: [String: Impact]

    struct Entry: Decodable, Sendable, Identifiable {
        let id: String
        let currency: String
        let format: String
        let fileName: String
        let statementFrom: String?
        let statementTo: String?
        let openingBalance: Int64?
        let openingBalanceDate: String?
        let closingBalance: Int64?
        let closingBalanceDate: String?
        let newCount: Int
        let duplicateCount: Int
        let warnings: [String]
        let createdAt: Int64
    }

    /// What undoing an import would delete besides the imported rows: edits made on them.
    struct Impact: Decodable, Sendable {
        let transactions: Int
        let categorized: Int
        let notes: Int
        let taxYears: Int
        let deductionYears: Int
        let billAllocations: Int
        let pillar3a: Int
        let transferLinks: Int
        let mirrors: Int
    }
}

/// The `data` of the action `undo`.
struct AccountUndoResult: Decodable, Sendable {
    let removedTransactions: Int
}
