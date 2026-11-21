import Observation
import SwiftUI

/// App-wide state: which server, who is signed in, and their session details.
@MainActor
@Observable
final class AppModel {
    private(set) var status: SessionStatus?
    private(set) var session: SessionDetails?

    let router = Router()

    @ObservationIgnored private let client = SDKClient.shared
    @ObservationIgnored private var watcher: Task<Void, Never>?

    var formats: Formats {
        Formats(
            localeTag: session?.preferences.locale ?? "en-GB",
            hideAmounts: session?.preferences.blurAmounts ?? false
        )
    }

    func start() {
        guard watcher == nil else { return }
        watcher = Task {
            await SDKClient.shared.watchStatus { [weak self] status in
                self?.apply(status)
            }
        }
    }

    private func apply(_ status: SessionStatus) {
        let wasSignedIn = isSignedIn
        self.status = status
        if isSignedIn {
            if !wasSignedIn { Task { await refreshSession() } }
        } else {
            session = nil
            router.paths = [:]
            router.tab = .overview
        }
    }

    var isSignedIn: Bool {
        if case .signedIn = status { return true }
        return false
    }

    /// Fetches user, preferences and the overdue count again; a failure keeps what is there.
    func refreshSession() async {
        guard isSignedIn else { return }
        do {
            session = try await client.session()
        } catch {
            // Offline or signed out meanwhile: the screens say so themselves.
        }
    }

    func logout() async {
        ReminderScheduler.cancelAll()
        await client.logout()
    }

    func disconnect() {
        ReminderScheduler.cancelAll()
        client.disconnect()
    }
}
