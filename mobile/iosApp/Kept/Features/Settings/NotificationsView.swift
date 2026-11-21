import SwiftUI

/// The server's own notifications: what triggers a message and where it goes (ntfy, webhook, email).
/// The reminders of this device are in the app's settings.
struct NotificationsView: View {
    @State private var store = PageStore<NotificationSettingsPage>(path: "settings/notifications")
    @State private var editing: NotificationSettingsEditTarget?
    @State private var removing: NotificationSettingsEditTarget?

    var body: some View {
        PageView("Server notifications", store: store) { page in
            List {
                NotificationSettingsTriggersSection(page: page, store: store)
                ForEach(NotificationSettingsLogic.shownKinds(page), id: \.self) { kind in
                    channelSection(page, kind: kind)
                }
                emailNote(page)
            }
        }
        .sheet(item: $editing) { target in
            NotificationSettingsChannelForm(store: store, kind: target.kind)
        }
        .confirmationDialog(
            "Remove channel",
            isPresented: removeDialog,
            titleVisibility: .visible,
            presenting: removing
        ) { target in
            Button("Remove \(NotificationSettingsLogic.label(target.kind))", role: .destructive) {
                Task { await remove(target.kind) }
            }
        } message: { _ in
            Text("Nothing is sent through this channel any more. Its saved settings and secret are deleted.")
        }
    }

    private var removeDialog: Binding<Bool> {
        Binding(
            get: { removing != nil },
            set: { if !$0 { removing = nil } }
        )
    }

    private func channel(_ page: NotificationSettingsPage, kind: String) -> NotificationSettingsPage.Channel? {
        page.channels.first { $0.kind == kind }
    }

    @ViewBuilder
    private func channelSection(_ page: NotificationSettingsPage, kind: String) -> some View {
        let current = channel(page, kind: kind)
        let locked = NotificationSettingsLogic.lockedMessage(page, kind: kind)
        Section {
            if let current {
                NotificationSettingsChannelStatus(channel: current)
            }
            if let locked {
                Text(locked).font(.footnote).foregroundStyle(KeptColor.warning)
            } else {
                Button {
                    editing = NotificationSettingsEditTarget(kind: kind)
                } label: {
                    Label(editLabel(current), systemImage: current == nil ? "plus" : "pencil")
                }
            }
            if let current {
                channelControls(current, locked: locked != nil)
            }
        } header: {
            Text(NotificationSettingsLogic.label(kind))
        } footer: {
            Text(NotificationSettingsLogic.hint(kind))
        }
    }

    private func editLabel(_ channel: NotificationSettingsPage.Channel?) -> String {
        guard let channel else { return "Add channel" }
        return channel.needsReentry ? "Enter the settings again" : "Edit"
    }

    @ViewBuilder
    private func channelControls(_ channel: NotificationSettingsPage.Channel, locked: Bool) -> some View {
        Toggle("Enabled", isOn: enabledBinding(channel))
            .disabled(store.busy)
        if !locked {
            Button {
                Task { await test(channel.kind) }
            } label: {
                Label("Send test", systemImage: "square.and.arrow.up")
            }
            .disabled(store.busy || channel.needsReentry)
        }
        Button(role: .destructive) {
            removing = NotificationSettingsEditTarget(kind: channel.kind)
        } label: {
            Label("Remove", systemImage: "trash")
        }
    }

    @ViewBuilder
    private func emailNote(_ page: NotificationSettingsPage) -> some View {
        let hasEmail = page.kinds.contains("email") || page.channels.contains { $0.kind == "email" }
        if !hasEmail, page.emailBlocked == nil {
            Section {
                Text("Email is not available: the administrator has not configured an SMTP server.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func enabledBinding(_ channel: NotificationSettingsPage.Channel) -> Binding<Bool> {
        Binding(
            get: { channel.enabled },
            set: { value in
                Task { await toggle(channel.kind, enabled: value) }
            }
        )
    }

    // MARK: Actions

    private func toggle(_ kind: String, enabled: Bool) async {
        var form = FormFields()
        form.set("kind", kind)
        form.set("enabled", enabled ? "true" : "false")
        await store.submit("toggleChannel", form: form, showRefusal: true)
    }

    private func remove(_ kind: String) async {
        var form = FormFields()
        form.set("kind", kind)
        await store.submit("deleteChannel", form: form, showRefusal: true)
    }

    private func test(_ kind: String) async {
        var form = FormFields()
        form.set("kind", kind)
        guard let result = await store.submit("testChannel", form: form, showRefusal: true, reload: false) else { return }
        if let answer = try? result.decode(NotificationSettingsTestAnswer.self) {
            if answer.result.ok {
                store.message = "Test message sent."
            } else {
                store.message = answer.result.reason ?? "The test message could not be sent."
            }
        }
        await store.load()
    }
}

struct NotificationSettingsChannelStatus: View {
    let channel: NotificationSettingsPage.Channel

    @Environment(\.formats) private var formats

    private var statusText: String {
        if channel.needsReentry { return "Needs re-entry" }
        return channel.enabled ? "Enabled" : "Paused"
    }

    private var statusColor: Color {
        if channel.needsReentry { return KeptColor.negative }
        return channel.enabled ? KeptColor.positive : Color.secondary
    }

    private var lastDelivery: String {
        guard let at = channel.lastSuccessAt else { return "Never" }
        return ImportText.dateTime(at, locale: formats.locale)
    }

    private var lastErrorText: String? {
        guard let error = channel.lastError, !error.isEmpty else { return nil }
        guard let at = channel.lastErrorAt else { return error }
        return error + " (" + ImportText.dateTime(at, locale: formats.locale) + ")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(NotificationSettingsLogic.channelSummary(channel))
                    .font(.footnote)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Pill(statusText, color: statusColor)
            }
            if channel.needsReentry {
                Text("The saved settings can no longer be read, probably because the server's secret key changed. Nothing is sent through this channel until you enter the settings again and save, or remove the channel.")
                    .font(.caption)
                    .foregroundStyle(KeptColor.negative)
            }
            Text("Last delivery: " + lastDelivery)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let lastErrorText {
                Text("Last error: " + lastErrorText)
                    .font(.caption)
                    .foregroundStyle(KeptColor.negative)
            }
        }
    }
}

// MARK: Triggers

struct NotificationSettingsTriggersSection: View {
    let page: NotificationSettingsPage
    let store: PageStore<NotificationSettingsPage>

    @State private var billDueEnabled: Bool
    @State private var billDueDays: String
    @State private var billOverdueEnabled: Bool
    @State private var budgetEnabled: Bool
    @State private var budgetPercent: String
    @State private var staleImportEnabled: Bool
    @State private var staleImportDays: String

    init(page: NotificationSettingsPage, store: PageStore<NotificationSettingsPage>) {
        self.page = page
        self.store = store
        let settings = page.settings
        _billDueEnabled = State(initialValue: settings.billDueEnabled)
        _billDueDays = State(initialValue: String(settings.billDueDays))
        _billOverdueEnabled = State(initialValue: settings.billOverdueEnabled)
        _budgetEnabled = State(initialValue: settings.budgetEnabled)
        _budgetPercent = State(initialValue: String(settings.budgetPercent))
        _staleImportEnabled = State(initialValue: settings.staleImportEnabled)
        _staleImportDays = State(initialValue: String(settings.staleImportDays))
    }

    var body: some View {
        Section {
            Toggle("Bill due soon", isOn: $billDueEnabled)
            if billDueEnabled {
                numberRow("Days before the due date", text: $billDueDays, field: "billDueDays")
            }
            Toggle("Bill overdue", isOn: $billOverdueEnabled)
            Toggle("Monthly budget reached", isOn: $budgetEnabled)
            if budgetEnabled {
                numberRow("Percent of the budget", text: $budgetPercent, field: "budgetPercent")
            }
            Toggle("Account without a recent import", isOn: $staleImportEnabled)
            if staleImportEnabled {
                numberRow("Days without an import", text: $staleImportDays, field: "staleImportDays")
            }
            FieldError(store.formErrors["form"])
            Button {
                Task { await save() }
            } label: {
                if store.busy {
                    ProgressView()
                } else {
                    Label("Save triggers", systemImage: "checkmark")
                }
            }
            .disabled(store.busy)
        } header: {
            Text("Triggers")
        } footer: {
            Text("Kept checks hourly and sends one message with everything new. Each event is only reported once. Messages go to your channels below and may contain amounts and names.")
        }
    }

    @ViewBuilder
    private func numberRow(_ title: String, text: Binding<String>, field: String) -> some View {
        LabeledContent(title) {
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
        }
        FieldError(store.formErrors[field])
    }

    private func save() async {
        let form = NotificationSettingsLogic.triggerForm(
            billDueEnabled: billDueEnabled,
            billDueDays: billDueDays,
            billOverdueEnabled: billOverdueEnabled,
            budgetEnabled: budgetEnabled,
            budgetPercent: budgetPercent,
            staleImportEnabled: staleImportEnabled,
            staleImportDays: staleImportDays
        )
        let result = await store.submit("saveSettings", form: form)
        if result != nil {
            store.message = "Triggers saved."
        }
    }
}

// MARK: Channel form

/// Add or change a channel. Secrets are write-only: the field starts empty and an empty field keeps the stored secret.
struct NotificationSettingsChannelForm: View {
    let store: PageStore<NotificationSettingsPage>
    let kind: String

    @State private var serverUrl: String
    @State private var topic: String
    @State private var url: String
    @State private var recipient: String
    @State private var secret = ""
    @State private var removeSecret = false

    init(store: PageStore<NotificationSettingsPage>, kind: String) {
        self.store = store
        self.kind = kind
        let channel = store.state.value?.channels.first { $0.kind == kind }
        _serverUrl = State(initialValue: channel?.fields["serverUrl"] ?? "")
        _topic = State(initialValue: channel?.fields["topic"] ?? "")
        _url = State(initialValue: channel?.fields["url"] ?? "")
        _recipient = State(initialValue: channel?.fields["to"] ?? "")
    }

    private var channel: NotificationSettingsPage.Channel? {
        store.state.value?.channels.first { $0.kind == kind }
    }

    private var secretHint: String {
        if channel?.hasSecret == true { return "A secret is stored. Leave empty to keep it." }
        return "Stored encrypted, never shown again."
    }

    var body: some View {
        FormSheet(
            NotificationSettingsLogic.label(kind),
            busy: store.busy,
            error: store.formErrors["form"]
        ) {
            await submit()
        } content: {
            switch kind {
            case "ntfy": ntfyFields()
            case "webhook": webhookFields()
            default: emailFields()
            }
        }
    }

    @ViewBuilder
    private func ntfyFields() -> some View {
        Section {
            TextField("Server", text: $serverUrl)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            FieldError(store.formErrors["serverUrl"])
            TextField("Topic", text: $topic)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            FieldError(store.formErrors["topic"])
            SecureField("Access token (optional)", text: $secret)
                .textContentType(.password)
            FieldError(store.formErrors["token"])
            removeToggle()
        } footer: {
            Text("https://ntfy.sh or your own server. " + secretHint)
        }
    }

    @ViewBuilder
    private func webhookFields() -> some View {
        Section {
            TextField("URL", text: $url)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            FieldError(store.formErrors["url"])
            SecureField("Signing secret (optional)", text: $secret)
                .textContentType(.password)
            FieldError(store.formErrors["secret"])
            removeToggle()
        } footer: {
            Text(secretHint)
        }
    }

    @ViewBuilder
    private func emailFields() -> some View {
        Section {
            TextField("Send to", text: $recipient)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            FieldError(store.formErrors["to"])
        }
    }

    @ViewBuilder
    private func removeToggle() -> some View {
        if channel?.hasSecret == true || channel?.needsReentry == true {
            Toggle("Remove the saved secret", isOn: $removeSecret)
        }
    }

    private func submit() async -> Bool {
        let form = NotificationSettingsLogic.channelForm(
            kind: kind,
            serverUrl: serverUrl,
            topic: topic,
            url: url,
            recipient: recipient,
            secret: secret,
            removeSecret: removeSecret
        )
        let result = await store.submit("saveChannel", form: form)
        return result != nil
    }
}
