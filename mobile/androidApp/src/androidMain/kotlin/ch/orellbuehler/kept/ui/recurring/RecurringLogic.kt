package ch.orellbuehler.kept.ui.recurring

import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.model.RecurringSeries

val cadences = listOf("weekly", "monthly", "quarterly", "yearly")

/** The series of each status, in the order the page lists them. */
data class RecurringGroups(
    val suggested: List<RecurringSeries>,
    val confirmed: List<RecurringSeries>,
    val dismissed: List<RecurringSeries>,
)

fun groupSeries(series: List<RecurringSeries>): RecurringGroups =
    RecurringGroups(
        suggested = series.filter { it.status == "suggested" },
        confirmed = series.filter { it.status == "confirmed" },
        dismissed = series.filter { it.status == "dismissed" },
    )

/** The fields of the web's edit form; the amount is shown without its sign, the series keeps its direction. */
fun editFields(
    id: String,
    name: String,
    cadence: String,
    amount: String,
): Map<String, String?> =
    linkedMapOf(
        "id" to id,
        "name" to name.trim(),
        "cadence" to cadence,
        "amount" to amount.trim(),
    )

fun idFields(id: String): Map<String, String?> = linkedMapOf("id" to id)

fun Map<String, String?>.toFormBody(): FormBody = FormBody().also { form -> forEach { (name, value) -> form.set(name, value) } }
