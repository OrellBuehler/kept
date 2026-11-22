import Foundation
@preconcurrency import shared

/// The one place that talks to the Kotlin `shared` framework. Everything it hands out is a plain
/// `Sendable` Swift value, so Kotlin objects never cross actors or reach a view.
final class SDKClient: @unchecked Sendable {
    static let shared = SDKClient()

    private let sdk: KeptSdk

    private init() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        sdk = KeptSdk(secure: KeychainStore(), prefs: DefaultsStore(), userAgent: "Kept-iOS/\(version)")
    }

    // MARK: Session

    var serverURL: String? { sdk.serverUrl }
    var insecure: Bool { sdk.insecure }

    func watchStatus(deliver: @MainActor @Sendable (SessionStatus) -> Void) async {
        for await state in sdk.state {
            let status = Self.status(state)
            await deliver(status)
        }
    }

    private static func status(_ state: SessionState) -> SessionStatus {
        switch onEnum(of: state) {
        case .noServer:
            return .noServer
        case let .signedOut(out):
            return .signedOut(serverURL: out.serverUrl, expired: out.expired)
        case let .signedIn(signedIn):
            let user = signedIn.user
            return .signedIn(
                serverURL: signedIn.serverUrl,
                user: SignedInUser(id: user.id, username: user.username, displayName: user.displayName, role: user.role)
            )
        }
    }

    func connect(_ address: String) async throws -> ServerDetails {
        try await call {
            let info = try await self.sdk.connect(address: address)
            return ServerDetails(version: info.version, setupRequired: info.setupRequired)
        }
    }

    func disconnect() {
        sdk.disconnect()
    }

    func login(username: String, password: String) async throws -> LoginOutcome {
        try await call {
            let step = try await self.sdk.login(username: username, password: password)
            switch onEnum(of: step) {
            case .done:
                return .done
            case let .codeRequired(required):
                return .codeRequired(totp: required.totp)
            }
        }
    }

    func verify(code: String) async throws {
        try await call {
            _ = try await self.sdk.verifyCode(code: code)
        }
    }

    func cancelSecondFactor() {
        sdk.cancelSecondFactor()
    }

    /// The scheme of the address the server's sign-in page sends the browser to when it is done.
    static let browserCallbackScheme = "ch.orellbuehler.kept"

    /// Starts a sign-in on the server's own login page; the address to open in a browser.
    func startBrowserSignIn() async throws -> URL {
        let address = try await call { try await self.sdk.startBrowserSignIn() }
        guard let url = URL(string: address) else { throw KeptError.unreadable }
        return url
    }

    /// After the browser came back: fetches the session for what was approved there.
    func finishBrowserSignIn() async throws {
        try await call {
            _ = try await self.sdk.finishBrowserSignIn()
        }
    }

    func cancelBrowserSignIn() {
        sdk.cancelBrowserSignIn()
    }

    func logout() async {
        do {
            try await sdk.logout()
        } catch {
            // logout() only fails when cancelled; the device is signed out either way.
        }
    }

    func session() async throws -> SessionDetails {
        let json = try await call { try await self.sdk.sessionJson() }
        return try Self.decode(SessionDetails.self, from: Data(json.utf8))
    }

    // MARK: Pages

    /// A page's data, decoded: `path` as in the server's registry ("bills", "accounts/<id>"),
    /// `query` as the web page reads it. Throws `KeptError` with `.redirect` when the page moved.
    func page<T: Decodable & Sendable>(
        _ path: String,
        query: [String: String] = [:],
        as type: T.Type = T.self
    ) async throws -> T {
        let json: String = try await call {
            let response = try await self.sdk.page(path: path, query: query)
            if let json = response.json { return json }
            throw KeptError(kind: .redirect, message: "The page moved.", redirect: response.redirect ?? "/")
        }
        return try Self.decode(T.self, from: Data(json.utf8))
    }

    /// Runs a page's form action. A refused form is a normal result with `ok == false`;
    /// everything else that goes wrong throws.
    func action(
        _ path: String,
        _ action: String,
        form: FormFields = FormFields(),
        query: [String: String] = [:]
    ) async throws -> ActionResult {
        try await call {
            let body = FormBody()
            for field in form.fields {
                _ = body.add(name: field.name, value: field.value)
            }
            for file in form.files {
                _ = body.file(
                    name: file.field,
                    fileName: file.name,
                    contentType: file.contentType,
                    base64: file.data.base64EncodedString()
                )
            }
            let response = try await self.sdk.action(path: path, action: action, form: body, query: query)
            return ActionResult(
                ok: response.ok,
                message: response.message,
                fieldErrors: response.fieldErrors,
                json: Data(response.json.utf8),
                redirect: response.redirect
            )
        }
    }

    /// A file the web serves: "bills/<id>/document", "reports/<kind>", "institutions/<id>/logo".
    func download(_ path: String, query: [String: String] = [:]) async throws -> DownloadedFile {
        try await call {
            let file = try await self.sdk.download(path: path, query: query)
            return DownloadedFile(data: file.toNSData() as Data, contentType: file.contentType, fileName: file.fileName)
        }
    }

    /// One of the JSON endpoints behind `/endpoints/`; a body makes it a POST.
    func endpoint<T: Decodable & Sendable>(
        _ path: String,
        query: [String: String] = [:],
        jsonBody: Data? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        let body = jsonBody.flatMap { String(data: $0, encoding: .utf8) }
        let json = try await call { try await self.sdk.endpoint(path: path, query: query, jsonBody: body) }
        return try Self.decode(T.self, from: Data(json.utf8))
    }

    // MARK: Reminders

    var reminderPreferences: ReminderPreferences {
        get {
            let settings = sdk.reminders.settings
            return ReminderPreferences(
                enabled: settings.enabled,
                billDue: settings.billDue,
                billDueDays: Int(settings.billDueDays),
                billOverdue: settings.billOverdue,
                budget: settings.budget,
                budgetPercent: Int(settings.budgetPercent),
                staleImport: settings.staleImport,
                staleImportDays: Int(settings.staleImportDays),
                hour: Int(settings.hour)
            )
        }
        set {
            sdk.reminders.settings = ReminderSettings(
                enabled: newValue.enabled,
                billDue: newValue.billDue,
                billDueDays: Int32(newValue.billDueDays),
                billOverdue: newValue.billOverdue,
                budget: newValue.budget,
                budgetPercent: Int32(newValue.budgetPercent),
                staleImport: newValue.staleImport,
                staleImportDays: Int32(newValue.staleImportDays),
                hour: Int32(newValue.hour)
            )
        }
    }

    /// Asks the server what is due and works out what to notify about; empty when reminders are off.
    func planReminders() async throws -> ReminderSchedule {
        try await call {
            let plan = try await self.sdk.reminders.plan(
                nowEpochSeconds: Int64(Date().timeIntervalSince1970),
                timeZoneId: TimeZone.current.identifier
            )
            let now = plan.now.map { notice in
                ReminderNotification(id: notice.key, title: notice.title, body: notice.body, billId: notice.billId, fireAt: nil)
            }
            let scheduled = plan.scheduled.map { reminder in
                ScheduledBillReminder(
                    id: reminder.id,
                    billId: reminder.bill.id,
                    creditorName: reminder.bill.creditorName,
                    invoiceNumber: reminder.bill.invoiceNumber,
                    remaining: reminder.bill.remaining?.int64Value,
                    currency: reminder.bill.currency,
                    dueDate: reminder.bill.dueDate,
                    daysBefore: Int(reminder.daysBefore),
                    fireAt: Date(timeIntervalSince1970: TimeInterval(reminder.fireAtEpochSeconds))
                )
            }
            return ReminderSchedule(now: now, scheduled: scheduled)
        }
    }

    func markRemindersShown(_ keys: [String]) {
        sdk.reminders.markShown(keys: keys)
    }

    // MARK: Helpers

    private func call<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as KeptError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw Self.map(error)
        }
    }

    private static func map(_ error: Error) -> KeptError {
        guard let exception = (error as NSError).kotlinException as? KeptException else {
            return KeptError(kind: .server, message: error.localizedDescription)
        }
        let kind: KeptError.Kind
        switch exception.kind {
        case .network: kind = .network
        case .notKept: kind = .notKept
        case .unauthorized: kind = .unauthorized
        case .forbidden: kind = .forbidden
        case .notFound: kind = .notFound
        case .rateLimited: kind = .rateLimited
        case .rejected: kind = .rejected
        default: kind = .server
        }
        return KeptError(
            kind: kind,
            message: exception.message ?? "The request failed.",
            status: Int(exception.status),
            retryAfterSeconds: exception.retryAfterSeconds?.intValue
        )
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            #if DEBUG
                print("decoding \(T.self) failed: \(error)")
            #endif
            throw KeptError.unreadable
        }
    }
}
