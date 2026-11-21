import SwiftUI

/// The frame of every screen: title, pull to refresh, and the loading / error / data states.
///
///     PageView("Bills", store: store) { page in
///         List { … }
///     }
///
/// `content` gets the loaded data. Use a `List` (or `ScrollView`) in it so pull to refresh works.
/// Messages of the store are shown as an alert, redirects are followed through the router.
struct PageView<T: Decodable & Sendable, Content: View>: View {
    let title: String
    @Bindable var store: PageStore<T>
    @ViewBuilder let content: (T) -> Content

    @Environment(Router.self) private var router

    init(_ title: String, store: PageStore<T>, @ViewBuilder content: @escaping (T) -> Content) {
        self.title = title
        self.store = store
        self.content = content
    }

    var body: some View {
        Group {
            switch store.state {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message, offline):
                ContentUnavailableView {
                    Label(
                        offline ? "The server cannot be reached" : "Something went wrong",
                        systemImage: offline ? "wifi.slash" : "exclamationmark.triangle"
                    )
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await store.load() } }
                        .buttonStyle(.borderedProminent)
                }
            case let .ready(value):
                content(value)
                    .refreshable { await store.load() }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .background(KeptColor.page)
        .task { await store.loadIfNeeded() }
        .messageAlert($store.message)
        .onChange(of: store.redirect) { _, target in
            guard let target else { return }
            store.redirect = nil
            router.follow(webPath: target, replacing: true)
        }
    }
}

extension View {
    /// Shows `message` in an alert and clears it when dismissed.
    func messageAlert(_ message: Binding<String?>) -> some View {
        alert(
            "Kept",
            isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } }),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(message.wrappedValue ?? "") }
        )
    }
}
