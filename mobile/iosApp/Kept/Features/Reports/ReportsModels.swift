import Foundation

/// `GET pages/reports`: what the report forms need (the accounts a statement can be made for).
struct ReportsPage: Decodable, Sendable {
    let today: String
    let hasShared: Bool
    let accounts: [Account]

    struct Account: Decodable, Sendable, Identifiable {
        let id: String
        let name: String
        let currency: String
        let iban: String?
        let archived: Bool
    }
}

enum ReportsLogic {
    /// The accounts to choose from: archived ones only when asked for.
    nonisolated static func visible(_ accounts: [ReportsPage.Account], showArchived: Bool) -> [ReportsPage.Account] {
        accounts.filter { showArchived || !$0.archived }
    }

    /// "Name (CHF)" and " · archived" for an archived account.
    nonisolated static func accountLabel(_ account: ReportsPage.Account) -> String {
        let base = account.name + " (" + account.currency + ")"
        return account.archived ? base + " · archived" : base
    }

    /// A statement needs an account and a period that does not end before it starts.
    nonisolated static func canDownloadStatement(accountId: String, from: String, to: String) -> Bool {
        !accountId.isEmpty && !from.isEmpty && !to.isEmpty && from <= to
    }

    nonisolated static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 2:
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
            return leap ? 29 : 28
        case 4, 6, 9, 11:
            return 30
        default:
            return 31
        }
    }

    /// The previous calendar month of `today` ("YYYY-MM-DD") as first and last day: what the statement form starts with.
    nonisolated static func lastFullMonth(today: String) -> (from: String, to: String) {
        let parts = today.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return ("", "") }
        var year = parts[0]
        var month = parts[1] - 1
        if month == 0 {
            month = 12
            year -= 1
        }
        let last = daysInMonth(year: year, month: month)
        let from = String(format: "%04d-%02d-01", year, month)
        let to = String(format: "%04d-%02d-%02d", year, month, last)
        return (from, to)
    }

    /// The years a tax report can be made for, newest first.
    nonisolated static func taxYears(today: String) -> [Int] {
        let year = Int(today.prefix(4)) ?? 2026
        return (0..<8).map { year - $0 }
    }

    /// A file name safe to write into the temporary directory.
    nonisolated static func safeFileName(_ name: String?, kind: String) -> String {
        let fallback = "kept-" + kind + ".pdf"
        guard let name, !name.isEmpty else { return fallback }
        let allowed = name.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }
        if allowed.isEmpty || allowed.hasPrefix(".") { return fallback }
        return allowed
    }
}
