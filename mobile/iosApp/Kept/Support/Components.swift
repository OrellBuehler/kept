import SwiftUI

/// How an amount is coloured.
enum AmountTone {
    /// The text colour around it.
    case plain
    /// Green when positive, red when negative: changes, transactions.
    case signed
    /// Red when negative only: balances.
    case negative
}

/// An amount in minor units, formatted for the user's locale with tabular digits. Hidden behind
/// dots when the user switched "blur amounts" on in Kept.
struct AmountText: View {
    let minor: Int64
    let currency: String
    var tone: AmountTone = .plain
    var showPlus = false

    @Environment(\.formats) private var formats

    init(_ minor: Int64, _ currency: String, tone: AmountTone = .plain, showPlus: Bool = false) {
        self.minor = minor
        self.currency = currency
        self.tone = tone
        self.showPlus = showPlus
    }

    private var color: Color? {
        if tone == .signed, minor > 0 { return KeptColor.positive }
        if tone != .plain, minor < 0 { return KeptColor.negative }
        return nil
    }

    var body: some View {
        Text(formats.hideAmounts ? "\(currency) •••" : formats.money(minor, currency, showPlus: showPlus))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(color ?? Color.primary)
    }
}

/// A small coloured label: a status, a type, a count.
struct Pill: View {
    let text: String
    var color: Color = .secondary

    init(_ text: String, color: Color = .secondary) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}

/// A round icon on a tinted background, the leading element of a row.
struct IconBadge: View {
    let systemImage: String
    var tint: Color = .accentColor

    init(_ systemImage: String, tint: Color = .accentColor) {
        self.systemImage = systemImage
        self.tint = tint
    }

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 36, height: 36)
            .background(tint.opacity(0.12), in: Circle())
    }
}

/// A row of a list: an optional icon, title and subtitle on the left, a value (usually an amount)
/// on the right. The title takes the free width, so a long name never squeezes the value.
///
///     ValueRow("Rent", subtitle: "Due 1 Apr") { AmountText(120000, "CHF") }
///     ValueRow("Forecast", systemImage: "chart.line.uptrend.xyaxis")
struct ValueRow<Trailing: View>: View {
    let title: String
    var subtitle: String?
    var systemImage: String?
    var tint: Color
    @ViewBuilder var trailing: () -> Trailing

    init(
        _ title: String,
        subtitle: String? = nil,
        systemImage: String? = nil,
        tint: Color = .accentColor,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.tint = tint
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: 12) {
            if let systemImage { IconBadge(systemImage, tint: tint) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) { trailing() }
        }
    }
}

extension ValueRow where Trailing == EmptyView {
    init(_ title: String, subtitle: String? = nil, systemImage: String? = nil, tint: Color = .accentColor) {
        self.init(title, subtitle: subtitle, systemImage: systemImage, tint: tint) { EmptyView() }
    }
}

/// A bar that fills with `fraction` (0…1 and beyond): budgets, progress towards a limit.
struct ProgressBar: View {
    let fraction: Double
    var color: Color = .accentColor

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(KeptColor.muted)
                Capsule().fill(color).frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 8)
    }
}

/// A form in a sheet: navigation bar with Cancel and Save, the fields in a `Form`, and the
/// form-level error underneath.
///
///     .sheet(isPresented: $adding) {
///         FormSheet("New budget", busy: store.busy, error: store.formErrors["form"]) {
///             await save()          // return true to close the sheet
///         } content: {
///             TextField("Amount", text: $amount)
///             FieldError(store.formErrors["amount"])
///         }
///     }
struct FormSheet<Content: View>: View {
    let title: String
    let busy: Bool
    var error: String?
    var submitLabel = "Save"
    var submitDisabled = false
    let onSubmit: () async -> Bool
    @ViewBuilder let content: () -> Content

    @Environment(\.dismiss) private var dismiss

    init(
        _ title: String,
        busy: Bool,
        error: String? = nil,
        submitLabel: String = "Save",
        submitDisabled: Bool = false,
        onSubmit: @escaping () async -> Bool,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.busy = busy
        self.error = error
        self.submitLabel = submitLabel
        self.submitDisabled = submitDisabled
        self.onSubmit = onSubmit
        self.content = content
    }

    var body: some View {
        NavigationStack {
            Form {
                content()
                if let error, !error.isEmpty {
                    Section { Text(error).foregroundStyle(KeptColor.negative) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button(submitLabel) {
                            Task { if await onSubmit() { dismiss() } }
                        }
                        .disabled(submitDisabled)
                    }
                }
            }
        }
    }
}

/// The server's error for one form field, shown under it. Renders nothing for `nil`.
struct FieldError: View {
    let text: String?

    init(_ text: String?) {
        self.text = text
    }

    var body: some View {
        if let text, !text.isEmpty {
            Text(text).font(.caption).foregroundStyle(KeptColor.negative)
        }
    }
}

/// A date as `YYYY-MM-DD` text (what the server expects), picked from a calendar. An empty string is "no date".
struct DateField: View {
    let title: String
    @Binding var value: String
    var optional = false

    init(_ title: String, value: Binding<String>, optional: Bool = false) {
        self.title = title
        _value = value
        self.optional = optional
    }

    private var date: Binding<Date> {
        Binding(
            get: { Formats.pickerDate(value) ?? Date() },
            set: { value = Formats.isoDate($0) }
        )
    }

    var body: some View {
        if optional, value.isEmpty {
            Button {
                value = Formats.isoDate(Date())
            } label: {
                HStack {
                    Text(title).foregroundStyle(Color.primary)
                    Spacer()
                    Text("Add").foregroundStyle(Color.accentColor)
                }
            }
        } else {
            HStack {
                DatePicker(title, selection: date, displayedComponents: .date)
                if optional {
                    Button {
                        value = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear")
                }
            }
        }
    }
}

/// An amount as the user types it ("1'234.50"); the server parses it, so send the text as is.
struct AmountField: View {
    let title: String
    @Binding var text: String
    var currency: String?

    init(_ title: String, text: Binding<String>, currency: String? = nil) {
        self.title = title
        _text = text
        self.currency = currency
    }

    var body: some View {
        HStack {
            TextField(title, text: $text)
                .keyboardType(.numbersAndPunctuation)
                .autocorrectionDisabled()
                .monospacedDigit()
            if let currency { Text(currency).foregroundStyle(.secondary) }
        }
    }
}
