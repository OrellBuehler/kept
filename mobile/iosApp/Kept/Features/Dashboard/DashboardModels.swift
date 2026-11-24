import Foundation

/// `GET pages/dashboard` (the web's "/"). Amounts are minor units of the `currency` next to them.
struct DashboardPage: Decodable, Sendable {
    var today: String = ""
    var forecastAlerts: [ForecastAlert] = []
    var needsAmount: [NeedsAmount] = []
    var dashboard: Dashboard

    /// An account whose projected balance goes below zero on `date`.
    struct ForecastAlert: Decodable, Sendable, Identifiable {
        let accountId: String
        var name: String = ""
        var currency: String = ""
        var date: String = ""
        var balance: Int64 = 0
        var id: String { accountId }
    }

    /// A transfer into another currency that still waits for the amount received.
    struct NeedsAmount: Decodable, Sendable, Identifiable {
        let transferId: String
        var sourceAccountId: String = ""
        var targetAccountName: String = ""
        var bookingDate: String = ""
        var id: String { transferId }
    }
}

struct Dashboard: Decodable, Sendable {
    var range: String = "12m"
    var hasShared: Bool = false
    var netWorth: NetWorth
    var accounts: [Account] = []
    var month: MonthSummary
    /// The month counted at the user's share of shared accounts; nil when nothing is shared.
    var shareMonth: MonthSummary?
    var spending: Spending
    var bills: Bills
    var unmatched: Unmatched
    var staleAccounts: Int = 0

    struct NetWorth: Decodable, Sendable {
        var series: [CurrencySeries] = []
        /// Like `series` with shared accounts at the user's share; nil when nothing is shared.
        var shareSeries: [CurrencySeries]?
        var totals: [Total] = []

        struct Total: Decodable, Sendable, Identifiable {
            let currency: String
            var balance: Int64 = 0
            var shareBalance: Int64 = 0
            var id: String { currency }
        }
    }

    struct CurrencySeries: Decodable, Sendable {
        let currency: String
        var points: [Point] = []

        struct Point: Decodable, Sendable, Identifiable {
            let date: String
            var amount: Int64 = 0
            var id: String { date }
        }
    }

    struct Account: Decodable, Sendable, Identifiable {
        let id: String
        var name: String = ""
        var type: String = ""
        var currency: String = ""
        var institution: InstitutionRef?
        var balance: Int64 = 0
        var shareBalance: Int64 = 0
        var stale: Bool = false
        var staleDays: Int?
        var lastImportAt: Int64?
        var lastCheckedAt: Int64?
    }

    struct MonthSummary: Decodable, Sendable {
        var month: String = ""
        var previousMonth: String = ""
        var totals: [Total] = []
        var previousTotals: [Total] = []

        struct Total: Decodable, Sendable, Identifiable {
            let currency: String
            var income: Int64 = 0
            var expenses: Int64 = 0
            var net: Int64 = 0
            var id: String { currency }
        }
    }

    struct Spending: Decodable, Sendable {
        var month: String = ""
        var currencies: [Currency] = []

        struct Currency: Decodable, Sendable, Identifiable {
            let currency: String
            var total: Int64 = 0
            var items: [Item] = []
            var id: String { currency }
        }

        struct Item: Decodable, Sendable {
            var categoryId: String?
            var name: String = ""
            var color: String?
            var spent: Int64 = 0
        }
    }

    struct Bills: Decodable, Sendable {
        var overdue: Bucket
        var dueSoon: Bucket
        var awaitingRefund: Bucket
        var upcoming: [Upcoming] = []

        struct Bucket: Decodable, Sendable {
            var count: Int = 0
        }

        struct Upcoming: Decodable, Sendable, Identifiable {
            let id: String
            var creditorName: String?
            var invoiceNumber: String?
            var amount: Int64?
            var remaining: Int64?
            var currency: String = ""
            var dueDate: String?
        }
    }

    struct Unmatched: Decodable, Sendable {
        var count: Int = 0
    }
}

/// An institution as it is embedded in accounts.
struct InstitutionRef: Decodable, Sendable, Hashable {
    let id: String
    var name: String = ""
    var color: String?
    var logoVersion: String?
    var websiteUrl: String?
}
