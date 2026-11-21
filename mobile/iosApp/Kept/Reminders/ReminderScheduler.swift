import BackgroundTasks
import Foundation
import UIKit
import UserNotifications

/// Reminders without a push service: when the app opens and on background refresh it asks the
/// server what is due, shows what is new, and schedules local notifications for upcoming due
/// dates so those fire even when the server cannot be reached at that moment.
enum ReminderScheduler {
    static let taskIdentifier = "ch.orellbuehler.kept.reminders"
    /// Posted (object: the bill id) when a reminder is tapped.
    static let openBill = Notification.Name("ch.orellbuehler.kept.openBill")
    private static let scheduledPrefix = "bill-due:"
    private static let refreshInterval: TimeInterval = 6 * 60 * 60

    /// Whether the system lets the app notify. Asks the user the first time when `request` is set.
    static func authorized(request: Bool) async -> Bool {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        switch status {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            guard request else { return false }
            return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        default:
            return false
        }
    }

    /// Checks the server once and brings the device's notifications up to date.
    static func sync() async {
        let client = SDKClient.shared
        guard client.reminderPreferences.enabled else {
            cancelAll()
            return
        }
        scheduleBackgroundRefresh()
        guard await authorized(request: false) else { return }
        let plan: ReminderSchedule
        do {
            plan = try await client.planReminders()
        } catch {
            // Offline or signed out: what is scheduled stays, the next refresh tries again.
            return
        }
        let center = UNUserNotificationCenter.current()
        for notice in plan.now {
            await add(id: notice.id, title: notice.title, body: notice.body, billId: notice.billId, at: nil, to: center)
        }
        client.markRemindersShown(plan.now.map(\.id))

        let pending = await center.pendingNotificationRequests().map(\.identifier)
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.hasPrefix(scheduledPrefix) })
        let formats = Formats(localeTag: Locale.current.identifier)
        for reminder in plan.scheduled {
            let who = reminder.creditorName ?? reminder.invoiceNumber ?? "A bill"
            let label = reminder.remaining.map { "\(who) (\(formats.money($0, reminder.currency)))" } ?? who
            let today = reminder.daysBefore == 0
            await add(
                id: reminder.id,
                title: today ? "Bill due today" : "Bill due soon",
                body: today ? "\(label) is due today." : "\(label) is due on \(formats.date(reminder.dueDate)).",
                billId: reminder.billId,
                at: reminder.fireAt,
                to: center
            )
        }
    }

    private static func add(
        id: String,
        title: String,
        body: String,
        billId: String?,
        at date: Date?,
        to center: UNUserNotificationCenter
    ) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let billId { content.userInfo = ["billId": billId] }
        var trigger: UNNotificationTrigger?
        if let date {
            let interval = date.timeIntervalSinceNow
            guard interval > 1 else { return }
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        }
        do {
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        } catch {
            // The system refused (not authorized any more, or too many pending): nothing to do.
        }
    }

    /// Removes what is scheduled and stops the background refresh.
    static func cancelAll() {
        UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
            let ids = requests.map(\.identifier).filter { $0.hasPrefix(scheduledPrefix) }
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
        }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
    }

    static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: refreshInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Not available (simulator, background refresh switched off): reminders then update when the app opens.
        }
    }

    /// The body of the background refresh task.
    static func backgroundRefresh() async {
        await sync()
    }
}

/// Shows reminders while the app is open and opens the bill a tapped reminder is about.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let billId = response.notification.request.content.userInfo["billId"] as? String
        guard let billId else { return }
        await MainActor.run {
            NotificationCenter.default.post(name: ReminderScheduler.openBill, object: billId)
        }
    }
}
