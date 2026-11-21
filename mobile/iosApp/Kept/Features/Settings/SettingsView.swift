import SwiftUI
import UIKit

/// The app's own settings (reminders, server, sign-out) and the way into Kept's settings pages.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.session) private var session
    @State private var confirmDisconnect = false

    private var host: String {
        let url = SDKClient.shared.serverURL ?? ""
        return url.components(separatedBy: "://").last ?? url
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    var body: some View {
        List {
            Section {
                ValueRow(session?.user.label ?? "Kept", subtitle: host, systemImage: "person")
                if SDKClient.shared.insecure {
                    Text("This connection is not encrypted. Use it only inside a network you trust.")
                        .font(.footnote)
                        .foregroundStyle(KeptColor.warning)
                }
            }

            RemindersSection()

            Section("Kept") {
                NavigationLink("Categories and rules", value: Route.settingsCategories)
                NavigationLink("Preferences", value: Route.settingsPreferences)
                NavigationLink("Server notifications", value: Route.settingsNotifications)
                NavigationLink("Market data", value: Route.settingsMarketData)
                NavigationLink("Password", value: Route.settingsAccount)
            }

            Section("In the browser") {
                browserLink("Two-step verification and passkeys", "settings/security")
                browserLink("API tokens", "settings/api-tokens")
                browserLink("Paperless", "settings/paperless")
                if session?.user.isAdmin == true {
                    browserLink("Users", "admin/users")
                    browserLink("Backup", "admin/backup")
                }
            }

            Section {
                Button("Sign out") {
                    Task { await model.logout() }
                }
                Button("Disconnect from this server", role: .destructive) {
                    confirmDisconnect = true
                }
            } footer: {
                Text("App version \(appVersion)")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Disconnect from this server",
            isPresented: $confirmDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) { model.disconnect() }
        } message: {
            Text("Signs you out and removes the server address and all settings from this device. Nothing is deleted on the server.")
        }
    }

    private func browserLink(_ title: String, _ path: String) -> some View {
        Button {
            router.openInBrowser(path)
        } label: {
            HStack {
                Text(title).foregroundStyle(Color.primary)
                Spacer()
                Image(systemName: "arrow.up.right.square").foregroundStyle(.secondary)
            }
        }
    }
}

private struct RemindersSection: View {
    @State private var preferences = SDKClient.shared.reminderPreferences
    @State private var denied = false

    var body: some View {
        Section {
            Toggle("Reminders on this device", isOn: enabled)
            if preferences.enabled {
                if denied {
                    Text("Notifications are switched off for Kept in the system settings.")
                        .font(.footnote)
                        .foregroundStyle(KeptColor.warning)
                    Button("Open system settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                }
                Toggle("Bills due soon", isOn: binding(\.billDue))
                if preferences.billDue {
                    Picker("Days before the due date", selection: binding(\.billDueDays)) {
                        ForEach([0, 1, 2, 3, 5, 7, 14], id: \.self) { Text("\($0)").tag($0) }
                    }
                    Picker("Time of day", selection: binding(\.hour)) {
                        ForEach(6 ..< 22, id: \.self) { Text(String(format: "%02d:00", $0)).tag($0) }
                    }
                }
                Toggle("Overdue bills", isOn: binding(\.billOverdue))
                Toggle("Budgets", isOn: binding(\.budget))
                if preferences.budget {
                    Picker("When used to", selection: binding(\.budgetPercent)) {
                        ForEach([50, 75, 90, 100], id: \.self) { Text("\($0) %").tag($0) }
                    }
                }
                Toggle("Accounts without a recent import", isOn: binding(\.staleImport))
                if preferences.staleImport {
                    Picker("After days without an import", selection: binding(\.staleImportDays)) {
                        ForEach([7, 14, 30, 60], id: \.self) { Text("\($0)").tag($0) }
                    }
                }
            }
        } header: {
            Text("Reminders")
        } footer: {
            Text("The app checks your server in the background and notifies you. Nothing is sent to a third party.")
        }
        .task { denied = preferences.enabled && !(await ReminderScheduler.authorized(request: false)) }
    }

    private var enabled: Binding<Bool> {
        Binding(
            get: { preferences.enabled },
            set: { on in
                preferences.enabled = on
                save()
                Task {
                    if on {
                        denied = !(await ReminderScheduler.authorized(request: true))
                    }
                    await ReminderScheduler.sync()
                }
            }
        )
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<ReminderPreferences, Value> & Sendable) -> Binding<Value> {
        Binding(
            get: { preferences[keyPath: keyPath] },
            set: { value in
                preferences[keyPath: keyPath] = value
                save()
                Task { await ReminderScheduler.sync() }
            }
        )
    }

    private func save() {
        SDKClient.shared.reminderPreferences = preferences
    }
}
