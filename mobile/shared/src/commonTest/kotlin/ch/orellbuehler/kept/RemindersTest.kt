package ch.orellbuehler.kept

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RemindersTest {
    private fun bill(
        id: String,
        due: String,
    ) = ReminderBill(id = id, creditorName = "Example Supplier", remaining = 1000, currency = "CHF", dueDate = due)

    // 2026-03-10T12:00:00Z
    private val now = 1773144000L

    @Test
    fun showsOnlyWhatWasNotShownBefore() {
        val snapshot =
            ReminderSnapshot(
                events =
                    listOf(
                        ReminderEvent("bill-overdue:b1:2026-03-01", "bill-overdue", "Bill overdue", "…"),
                        ReminderEvent("budget:x:2026-03:100", "budget", "Budget exceeded", "…"),
                    ),
            )
        val plan = planFrom(snapshot, ReminderSettings(enabled = true), setOf("budget:x:2026-03:100"), now, "UTC")
        assertEquals(listOf("bill-overdue:b1:2026-03-01"), plan.now.map { it.key })
        assertEquals("b1", plan.now.single().billId)
        assertEquals("bill-overdue", plan.now.single().kind)
    }

    @Test
    fun onlyBillNoticesPointToABill() {
        val snapshot = ReminderSnapshot(events = listOf(ReminderEvent("stale-import:a1:2026-01-01", "", "Account not imported", "…")))
        val notice = planFrom(snapshot, ReminderSettings(enabled = true), emptySet(), now, "UTC").now.single()
        assertNull(notice.billId)
        assertEquals("stale-import", notice.kind)
    }

    @Test
    fun schedulesBeforeAndOnTheDueDateAtTheChosenHour() {
        val snapshot = ReminderSnapshot(bills = listOf(bill("b1", "2026-03-20")))
        val plan = planFrom(snapshot, ReminderSettings(enabled = true, billDueDays = 3, hour = 9), emptySet(), now, "Europe/Zurich")
        assertEquals(listOf(3, 0), plan.scheduled.map { it.daysBefore })
        // 2026-03-17T09:00 in Zurich (UTC+1) is 08:00Z.
        assertEquals(1773734400L, plan.scheduled[0].fireAtEpochSeconds)
        assertEquals("bill-due:b1:2026-03-20:3", plan.scheduled[0].id)
        assertEquals(plan.scheduled[0].fireAtEpochSeconds + 3 * 86400, plan.scheduled[1].fireAtEpochSeconds)
    }

    @Test
    fun leavesOutWhatIsAlreadyPast() {
        val snapshot = ReminderSnapshot(bills = listOf(bill("soon", "2026-03-11"), bill("past", "2026-03-01")))
        val plan = planFrom(snapshot, ReminderSettings(enabled = true, billDueDays = 3), emptySet(), now, "UTC")
        assertEquals(listOf("bill-due:soon:2026-03-11:0"), plan.scheduled.map { it.id })
    }

    @Test
    fun schedulesNothingWhenBillRemindersAreOffAndCapsTheRest() {
        val many = ReminderSnapshot(bills = (1..60).map { bill("b$it", "2026-04-${(it % 28 + 1).toString().padStart(2, '0')}") })
        assertTrue(planFrom(many, ReminderSettings(enabled = true, billDue = false), emptySet(), now, "UTC").scheduled.isEmpty())
        val capped = planFrom(many, ReminderSettings(enabled = true), emptySet(), now, "UTC").scheduled
        assertEquals(MAX_SCHEDULED, capped.size)
        assertEquals(capped.sortedBy { it.fireAtEpochSeconds }, capped)
    }

    @Test
    fun aBadDateOrZoneDoesNotBreakThePlan() {
        val snapshot = ReminderSnapshot(bills = listOf(bill("b1", "soon"), bill("b2", "2026-03-20")))
        val plan = planFrom(snapshot, ReminderSettings(enabled = true, billDueDays = 0), emptySet(), now, "Nowhere/Land")
        assertEquals(listOf("bill-due:b2:2026-03-20:0"), plan.scheduled.map { it.id })
    }

    @Test
    fun settingsAndShownKeysAreStored() {
        val prefs = MemoryStore()
        val sdk =
            KeptSdk(
                MemoryStore(),
                prefs,
                engine =
                    io.ktor.client.engine.mock
                        .MockEngine { error("unused") },
            )
        assertEquals(ReminderSettings(), sdk.reminders.settings)
        sdk.reminders.settings = ReminderSettings(enabled = true, billDueDays = 7)
        assertEquals(7, sdk.reminders.settings.billDueDays)
        sdk.reminders.markShown(listOf("a", "b"))
        sdk.reminders.markShown(listOf("b", "c"))
        assertEquals("""["a","b","c"]""", prefs.values["reminders.shown"])
    }
}
