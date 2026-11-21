import Foundation

/// `GET pages/settings/notifications`: the server's own notification triggers and channels.
struct NotificationSettingsPage: Decodable, Sendable {
    struct Triggers: Decodable, Sendable, Equatable {
        var billDueEnabled: Bool
        var billDueDays: Int
        var billOverdueEnabled: Bool
        var budgetEnabled: Bool
        var budgetPercent: Int
        var staleImportEnabled: Bool
        var staleImportDays: Int
    }

    struct Channel: Decodable, Sendable, Identifiable {
        let kind: String
        let enabled: Bool
        /// Public settings of the channel (server and topic, URL, recipient). Secrets are never sent.
        let fields: [String: String]
        let hasSecret: Bool
        let needsReentry: Bool
        let lastSuccessAt: Int64?
        let lastError: String?
        let lastErrorAt: Int64?

        var id: String { kind }
    }

    let settings: Triggers
    let channels: [Channel]
    /// "smtp": the administrator has not configured email; "admin": email is for administrators only.
    let emailBlocked: String?
    let kinds: [String]
}

/// What `testChannel` answers.
struct NotificationSettingsTestAnswer: Decodable, Sendable {
    struct Outcome: Decodable, Sendable {
        let ok: Bool
        let reason: String?
    }

    let result: Outcome
}

struct NotificationSettingsEditTarget: Identifiable {
    let kind: String

    var id: String { kind }
}

enum NotificationSettingsLogic {
    nonisolated static let allKinds: [String] = ["ntfy", "webhook", "email"]

    nonisolated static func label(_ kind: String) -> String {
        switch kind {
        case "ntfy": return "ntfy"
        case "webhook": return "Webhook"
        case "email": return "Email"
        default: return kind
        }
    }

    nonisolated static func hint(_ kind: String) -> String {
        switch kind {
        case "ntfy":
            return "Messages are published to this topic. Add an access token if the topic is protected."
        case "webhook":
            return "Kept POSTs JSON (source, title, message, sentAt). With a secret, the request carries x-kept-signature: sha256=<HMAC-SHA256 of the body>."
        default:
            return "Sent through the SMTP server your administrator configured."
        }
    }

    /// The kinds the page shows: the ones the server offers and the ones that already have a channel.
    nonisolated static func shownKinds(_ page: NotificationSettingsPage) -> [String] {
        allKinds.filter { kind in
            page.kinds.contains(kind) || page.channels.contains { $0.kind == kind }
        }
    }

    nonisolated static func lockedMessage(_ page: NotificationSettingsPage, kind: String) -> String? {
        guard kind == "email", let reason = page.emailBlocked else { return nil }
        if reason == "admin" { return "Email notifications are limited to administrators." }
        return "The administrator has not configured an SMTP server."
    }

    /// The fields of `saveSettings`: switches are "on" or absent, numbers are typed text.
    nonisolated static func triggerForm(
        billDueEnabled: Bool,
        billDueDays: String,
        billOverdueEnabled: Bool,
        budgetEnabled: Bool,
        budgetPercent: String,
        staleImportEnabled: Bool,
        staleImportDays: String
    ) -> FormFields {
        var form = FormFields()
        form.check("billDueEnabled", billDueEnabled)
        form.set("billDueDays", billDueDays.trimmingCharacters(in: .whitespaces))
        form.check("billOverdueEnabled", billOverdueEnabled)
        form.check("budgetEnabled", budgetEnabled)
        form.set("budgetPercent", budgetPercent.trimmingCharacters(in: .whitespaces))
        form.check("staleImportEnabled", staleImportEnabled)
        form.set("staleImportDays", staleImportDays.trimmingCharacters(in: .whitespaces))
        return form
    }

    /// The fields of `saveChannel`. A blank secret keeps the stored one, so it is sent blank; `removeSecret` drops it.
    nonisolated static func channelForm(
        kind: String,
        serverUrl: String,
        topic: String,
        url: String,
        recipient: String,
        secret: String,
        removeSecret: Bool
    ) -> FormFields {
        var form = FormFields()
        form.set("kind", kind)
        switch kind {
        case "ntfy":
            form.set("serverUrl", serverUrl.trimmingCharacters(in: .whitespaces))
            form.set("topic", topic.trimmingCharacters(in: .whitespaces))
            form.set("token", secret)
            form.check("removeSecret", removeSecret)
        case "webhook":
            form.set("url", url.trimmingCharacters(in: .whitespaces))
            form.set("secret", secret)
            form.check("removeSecret", removeSecret)
        default:
            form.set("to", recipient.trimmingCharacters(in: .whitespaces))
        }
        return form
    }

    nonisolated static func channelSummary(_ channel: NotificationSettingsPage.Channel) -> String {
        switch channel.kind {
        case "ntfy":
            let server = channel.fields["serverUrl"] ?? ""
            let topic = channel.fields["topic"] ?? ""
            return server + " / " + topic
        case "webhook": return channel.fields["url"] ?? ""
        default: return channel.fields["to"] ?? ""
        }
    }
}
