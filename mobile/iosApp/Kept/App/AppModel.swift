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
        #if DEBUG
            Task { await screenshotLaunch() }
        #endif
    }

    #if DEBUG
        /// Store screenshots (mobile/scripts/screenshots/ios.sh), debug builds only: the script
        /// names the server, the user and the page as launch arguments. Signs in unless the app
        /// already is signed in, then opens the page.
        private func screenshotLaunch() async {
            let arguments = UserDefaults.standard
            guard let server = arguments.string(forKey: "screenshot_server"),
                  let username = arguments.string(forKey: "screenshot_username"),
                  let password = arguments.string(forKey: "screenshot_password")
            else { return }
            while status == nil {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if !isSignedIn {
                do {
                    _ = try await client.connect(server)
                    guard case .done = try await client.login(username: username, password: password) else {
                        print("screenshots: the account asks for a second factor")
                        return
                    }
                } catch {
                    print("screenshots: sign-in failed")
                    return
                }
                // The statuses of the sign-in arrive one after the other and the earlier ones reset the router.
                while !isSignedIn {
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
            if let path = arguments.string(forKey: "screenshot_path") {
                router.open(webPath: path)
            }
        }
    #endif

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
