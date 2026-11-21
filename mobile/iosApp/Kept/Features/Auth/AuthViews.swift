import Observation
import SwiftUI

@MainActor
@Observable
final class AuthModel {
    var busy = false
    var error: String?
    /// The server that was just connected has no user yet. Static: the login screen has its own model.
    static var setupRequired = false
    /// Set while the second factor is asked for; true when an authenticator code works.
    var codeTotp: Bool?

    @ObservationIgnored private let client = SDKClient.shared

    func connect(_ address: String) async {
        await run {
            let info = try await self.client.connect(address)
            Self.setupRequired = info.setupRequired
        }
    }

    func login(username: String, password: String) async {
        await run {
            let outcome = try await self.client.login(
                username: username.trimmingCharacters(in: .whitespaces),
                password: password
            )
            if case let .codeRequired(totp) = outcome { self.codeTotp = totp }
        }
    }

    func verify(code: String) async {
        await run {
            do {
                try await self.client.verify(code: code.trimmingCharacters(in: .whitespaces))
            } catch let error as KeptError {
                if error.status == 410 { self.codeTotp = nil }
                throw error
            }
        }
    }

    func cancelCode() {
        client.cancelSecondFactor()
        codeTotp = nil
        error = nil
    }

    func changeServer() {
        client.disconnect()
    }

    private func run(_ body: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await body()
        } catch let failure as KeptError {
            if failure.kind == .rateLimited, let seconds = failure.retryAfterSeconds {
                error = "\(failure.message) (\(seconds) s)"
            } else {
                error = failure.message
            }
        } catch {
            // Cancelled: nothing to show.
        }
    }
}

private struct AuthFrame<Content: View>: View {
    let title: String
    let text: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "k.square.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(Color.primary)
                    .padding(.top, 48)
                Text(title).font(.title2.weight(.semibold))
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                VStack(spacing: 12) { content() }
                    .padding(.top, 8)
            }
            .padding(24)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        .background(KeptColor.page)
    }
}

private struct SubmitButton: View {
    let title: String
    let busy: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if busy { ProgressView() } else { Text(title) }
            }
            .frame(maxWidth: .infinity, minHeight: 28)
        }
        .buttonStyle(.borderedProminent)
        .disabled(disabled || busy)
    }
}

private struct ErrorText: View {
    let text: String?

    var body: some View {
        if let text, !text.isEmpty {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(KeptColor.negative)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// First start: which server to talk to.
struct ServerView: View {
    @State private var model = AuthModel()
    @State private var address = ""

    var body: some View {
        AuthFrame(
            title: "Connect to your server",
            text: "Kept runs on a server you host. Enter its address to continue."
        ) {
            TextField("kept.example.org", text: $address)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { Task { await model.connect(address) } }
            ErrorText(text: model.error)
            SubmitButton(title: "Connect", busy: model.busy, disabled: address.isEmpty) {
                Task { await model.connect(address) }
            }
        }
    }
}

/// Username and password, then the second factor when the account has one.
struct LoginView: View {
    let serverURL: String
    let expired: Bool

    @State private var model = AuthModel()
    @State private var username = ""
    @State private var password = ""
    @State private var code = ""

    private var host: String {
        serverURL.components(separatedBy: "://").last ?? serverURL
    }

    var body: some View {
        if let totp = model.codeTotp {
            AuthFrame(
                title: "Two-step verification",
                text: totp
                    ? "Enter the code from your authenticator app, or a recovery code."
                    : "This account signs in with a passkey, which the app cannot use. Enter one of your recovery codes."
            ) {
                TextField("Code", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(totp ? .numberPad : .asciiCapable)
                    .textContentType(.oneTimeCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                ErrorText(text: model.error)
                SubmitButton(title: "Verify", busy: model.busy, disabled: code.isEmpty) {
                    Task { await model.verify(code: code) }
                }
                Button("Start again") {
                    code = ""
                    model.cancelCode()
                }
            }
        } else {
            AuthFrame(title: "Sign in", text: host) {
                if serverURL.hasPrefix("http://") {
                    Text("This connection is not encrypted. Use it only inside a network you trust.")
                        .font(.footnote)
                        .foregroundStyle(KeptColor.warning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if AuthModel.setupRequired {
                    Text("This server has no user yet. Open it in a browser to finish the setup, then come back.")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if expired, model.error == nil {
                    Text("Your session has ended. Sign in again.")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                TextField("Username", text: $username)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit { Task { await model.login(username: username, password: password) } }
                ErrorText(text: model.error)
                SubmitButton(title: "Sign in", busy: model.busy, disabled: username.isEmpty || password.isEmpty) {
                    Task { await model.login(username: username, password: password) }
                }
                Button("Use another server") { model.changeServer() }
            }
        }
    }
}
