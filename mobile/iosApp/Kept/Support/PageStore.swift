import Foundation
import Observation

/// What a screen shows for the data it loads.
enum LoadState<T: Sendable>: Sendable {
    case loading
    /// `offline`: the server could not be reached.
    case failed(message: String, offline: Bool)
    case ready(T)

    var value: T? {
        if case let .ready(value) = self { return value }
        return nil
    }
}

/// The model of a screen: loads one page of `/api/app/v1/pages/`, keeps the last data while it
/// reloads, and runs the page's form actions.
///
///     @State private var store = PageStore<BillsPage>(path: "bills")
///
/// A refused form fills `formErrors` ("form" holds the errors that belong to no field); anything
/// else that fails lands in `message`, which `PageView` shows as an alert.
@MainActor
@Observable
final class PageStore<T: Decodable & Sendable> {
    private(set) var state: LoadState<T> = .loading
    /// True while an action runs: disable the buttons that would start another.
    private(set) var busy = false
    var formErrors: [String: String] = [:]
    /// Something to tell the user once (an error of an action or a failed refresh).
    var message: String?
    /// A web path the page or an action navigates to; `PageView` follows it and clears it.
    var redirect: String?

    let path: String
    /// The query the page is loaded with. Change it and call `load()` (e.g. another month).
    var query: [String: String]

    @ObservationIgnored private let client = SDKClient.shared
    @ObservationIgnored private var loaded = false

    init(path: String, query: [String: String] = [:]) {
        self.path = path
        self.query = query
    }

    /// Loads once; later calls do nothing. Use it from `.task`.
    func loadIfNeeded() async {
        if !loaded { await load() }
    }

    /// Loads again; data already on screen stays visible meanwhile.
    func load() async {
        loaded = true
        do {
            state = .ready(try await client.page(path, query: query, as: T.self))
        } catch let error as KeptError {
            if error.kind == .redirect {
                redirect = error.redirect
            } else if state.value != nil {
                message = error.message
            } else {
                state = .failed(message: error.message, offline: error.isOffline)
            }
        } catch {
            // Cancelled (the view went away, or a newer refresh replaced this one): keep what is there.
        }
    }

    /// Runs a form action of this page (or of `path`, for an action that lives on another page).
    ///
    /// Returns the result when the action succeeded, after reloading the page (unless `reload` is
    /// false); `nil` when the form was refused or the request failed. `showRefusal` also shows the
    /// first error of a refused form as a message, for actions without a form on screen.
    @discardableResult
    func submit(
        _ action: String,
        form: FormFields = FormFields(),
        path: String? = nil,
        query: [String: String] = [:],
        showRefusal: Bool = false,
        reload: Bool = true
    ) async -> ActionResult? {
        guard !busy else { return nil }
        busy = true
        formErrors = [:]
        defer { busy = false }
        do {
            let result = try await client.action(path ?? self.path, action, form: form, query: query)
            guard result.ok else {
                formErrors = result.fieldErrors
                if showRefusal || result.fieldErrors.isEmpty { message = result.message }
                return nil
            }
            if let target = result.redirect { redirect = target }
            if reload { await load() }
            return result
        } catch let error as KeptError {
            message = error.message
            return nil
        } catch {
            return nil
        }
    }
}
