import Foundation

// Plain Swift values the views use. Nothing here imports `shared`: the Kotlin types stay behind `SDKClient`.

enum SessionStatus: Sendable, Equatable {
    case noServer
    case signedOut(serverURL: String, expired: Bool)
    case signedIn(serverURL: String, user: SignedInUser)
}

struct SignedInUser: Codable, Sendable, Equatable {
    let id: String
    let username: String
    var displayName: String?
    var role: String?

    var isAdmin: Bool { role == "admin" }
    var label: String {
        if let displayName, !displayName.isEmpty { return displayName }
        return username
    }
}

struct UserPreferences: Codable, Sendable, Equatable {
    var ibanDisplay: String = "full"
    var blurAmounts: Bool = false
    var locale: String = "en-GB"
    var defaultCurrency: String = "CHF"
    var pageSize: Int = 50
    var investmentCashLiquid: Bool = false
}

/// `GET /api/app/v1/session`: who is signed in and what every screen needs.
struct SessionDetails: Codable, Sendable, Equatable {
    let user: SignedInUser
    var today: String = ""
    var overdueBills: Int = 0
    var preferences = UserPreferences()
    var twoFactor: Bool = false
}

struct ServerDetails: Sendable {
    let version: String
    let setupRequired: Bool
}

enum LoginOutcome: Sendable {
    case done
    /// The account has a second factor. `totp` is false when only a recovery code works in the app.
    case codeRequired(totp: Bool)
}

/// Why a call to the server failed, coarse enough for the UI to decide what to show.
struct KeptError: Error, LocalizedError, Sendable {
    enum Kind: Sendable {
        case network, notKept, unauthorized, forbidden, notFound, rateLimited, rejected, server
        /// A page answered with a redirect instead of data; `KeptError.redirect` holds the web path.
        case redirect
    }

    let kind: Kind
    let message: String
    var status: Int = 0
    var retryAfterSeconds: Int?
    var redirect: String?

    var errorDescription: String? { message }
    var isOffline: Bool { kind == .network }

    static let unreadable = KeptError(
        kind: .server,
        message: "The server answered something this app does not understand. Update the app or the server."
    )
}

/// The fields of a web form, as the page's action expects them.
struct FormFields: Sendable {
    struct File: Sendable {
        let field: String
        let name: String
        let contentType: String
        let data: Data
    }

    private(set) var fields: [(name: String, value: String)] = []
    private(set) var files: [File] = []

    init() {}

    /// `["amount": "12.50", "note": nil]`: a `nil` value is not sent.
    init(_ values: KeyValuePairs<String, String?>) {
        for (name, value) in values {
            if let value { fields.append((name, value)) }
        }
    }

    /// Sets a field; `nil` removes it.
    mutating func set(_ name: String, _ value: String?) {
        fields.removeAll { $0.name == name }
        if let value { fields.append((name, value)) }
    }

    /// A checkbox: sent as "on" when ticked, left out otherwise, like a browser.
    mutating func check(_ name: String, _ on: Bool) {
        set(name, on ? "on" : nil)
    }

    /// Adds a value to a repeated field.
    mutating func add(_ name: String, _ value: String) {
        fields.append((name, value))
    }

    mutating func file(_ field: String, name: String, contentType: String, data: Data) {
        files.append(File(field: field, name: name, contentType: contentType, data: data))
    }
}

struct ActionResult: Sendable {
    let ok: Bool
    /// For a refused form: the first error, ready to show.
    let message: String?
    /// Errors by form field ("form" for the ones that belong to no field).
    let fieldErrors: [String: String]
    /// What the action returned (`data`) as JSON.
    let json: Data
    /// Where the web page navigates after the action, if it does.
    let redirect: String?

    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: json)
        } catch {
            throw KeptError.unreadable
        }
    }
}

struct DownloadedFile: Sendable {
    let data: Data
    let contentType: String
    let fileName: String?
}

/// What this device reminds about. Kept on the device.
struct ReminderPreferences: Sendable, Equatable {
    var enabled = false
    var billDue = true
    var billDueDays = 3
    var billOverdue = true
    var budget = false
    var budgetPercent = 100
    var staleImport = false
    var staleImportDays = 14
    var hour = 9
}

struct ReminderNotification: Sendable {
    let id: String
    let title: String
    let body: String
    let billId: String?
    /// nil: show now.
    let fireAt: Date?
}

struct ReminderSchedule: Sendable {
    /// Not shown on this device before; `keys` go to `SDKClient.markRemindersShown` once posted.
    let now: [ReminderNotification]
    /// Replaces everything scheduled earlier.
    let scheduled: [ScheduledBillReminder]
}

struct ScheduledBillReminder: Sendable {
    let id: String
    let billId: String
    let creditorName: String?
    let invoiceNumber: String?
    let remaining: Int64?
    let currency: String
    let dueDate: String
    let daysBefore: Int
    let fireAt: Date
}
