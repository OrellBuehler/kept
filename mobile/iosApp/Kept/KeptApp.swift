import SwiftUI

@main
struct KeptApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.router)
                .environment(\.formats, model.formats)
                .environment(\.session, model.session)
                .task { model.start() }
                .onReceive(NotificationCenter.default.publisher(for: ReminderScheduler.openBill)) { note in
                    if let id = note.object as? String { model.router.openBill(id) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await model.refreshSession()
                    await ReminderScheduler.sync()
                }
            }
        }
        .backgroundTask(.appRefresh(ReminderScheduler.taskIdentifier)) {
            await ReminderScheduler.backgroundRefresh()
        }
    }
}
