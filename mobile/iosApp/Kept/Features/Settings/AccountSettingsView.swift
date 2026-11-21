import SwiftUI

/// `GET pages/settings/account`.
struct AccountSettingsPage: Decodable, Sendable {
    struct User: Decodable, Sendable {
        let id: String
        let username: String
        let displayName: String?
        let role: String
    }

    let user: User
}

enum AccountSettingsLogic {
    nonisolated static let minimumLength = 10

    /// The message under the confirmation field, or nil when the new password can be sent.
    nonisolated static func problem(newPassword: String, confirmation: String) -> String? {
        if newPassword.count < minimumLength { return "At least \(minimumLength) characters." }
        if confirmation != newPassword { return "Passwords do not match." }
        return nil
    }

    /// The fields of `changePassword`; the confirmation is checked on the device only.
    nonisolated static func form(current: String, new: String) -> FormFields {
        var form = FormFields()
        form.set("currentPassword", current)
        form.set("newPassword", new)
        return form
    }
}

/// Who is signed in and the password change.
struct AccountSettingsView: View {
    @State private var store = PageStore<AccountSettingsPage>(path: "settings/account")

    var body: some View {
        PageView("Password", store: store) { page in
            AccountSettingsForm(page: page, store: store)
        }
    }
}

struct AccountSettingsForm: View {
    let page: AccountSettingsPage
    let store: PageStore<AccountSettingsPage>

    @State private var current = ""
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var touched = false

    private var mismatch: String? {
        if !touched { return nil }
        return AccountSettingsLogic.problem(newPassword: newPassword, confirmation: confirmation)
    }

    private var canSubmit: Bool {
        !current.isEmpty
            && AccountSettingsLogic.problem(newPassword: newPassword, confirmation: confirmation) == nil
            && !store.busy
    }

    var body: some View {
        Form {
            profileSection()
            passwordSection()
        }
    }

    @ViewBuilder
    private func profileSection() -> some View {
        Section("Profile") {
            LabeledContent("Username", value: page.user.username)
            LabeledContent("Display name", value: page.user.displayName ?? "Not set")
            LabeledContent("Role", value: page.user.role == "admin" ? "Admin" : "Member")
        }
    }

    @ViewBuilder
    private func passwordSection() -> some View {
        Section {
            SecureField("Current password", text: $current)
                .textContentType(.password)
            FieldError(store.formErrors["currentPassword"])
            SecureField("New password", text: $newPassword)
                .textContentType(.newPassword)
            FieldError(store.formErrors["newPassword"])
            SecureField("Confirm new password", text: $confirmation)
                .textContentType(.newPassword)
                .onChange(of: confirmation) { _, _ in
                    touched = true
                }
            FieldError(mismatch)
            FieldError(store.formErrors["form"])
            Button {
                Task { await change() }
            } label: {
                if store.busy {
                    ProgressView()
                } else {
                    Text("Change password")
                }
            }
            .disabled(!canSubmit)
        } header: {
            Text("Change password")
        } footer: {
            Text("At least 10 characters. Other devices are signed out when you change your password.")
        }
    }

    private func change() async {
        let form = AccountSettingsLogic.form(current: current, new: newPassword)
        let result = await store.submit("changePassword", form: form, reload: false)
        if result != nil {
            current = ""
            newPassword = ""
            confirmation = ""
            touched = false
            store.message = "Password changed."
        }
    }
}
