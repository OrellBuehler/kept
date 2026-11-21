package ch.orellbuehler.kept.ui.imports

import ch.orellbuehler.kept.model.ImportDetectedColumn
import ch.orellbuehler.kept.model.ImportMappingPage
import ch.orellbuehler.kept.model.ImportPreviewRow
import ch.orellbuehler.kept.ui.components.Choice
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

val DELIMITERS = listOf("auto", ",", ";", "\t", "|")
val ENCODINGS = listOf("auto", "utf-8", "utf-16le", "windows-1252", "iso-8859-1")
val DATE_FORMATS = listOf("YYYY-MM-DD", "DD.MM.YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YY", "YYYYMMDD")
val DECIMAL_SEPARATORS = listOf(".", ",")
val THOUSANDS_SEPARATORS = listOf("", "'", ",", ".", " ")
val AMOUNT_MODES = listOf("single", "single_with_indicator", "split")

private val DEFAULT_CREDIT = listOf("CRDT", "Credit", "CR", "C")
private val DEFAULT_DEBIT = listOf("DBIT", "Debit", "DR", "D")

/** The columns of the profile the form has a field for (the description has its own list). */
val MANAGED_COLUMNS =
    listOf(
        "bookingDate",
        "valueDate",
        "amount",
        "credit",
        "debit",
        "indicator",
        "currency",
        "counterpartyName",
        "counterpartyIban",
        "reference",
        "externalId",
        "balance",
    )

private val AMOUNT_COLUMNS = listOf("amount", "credit", "debit", "indicator")

/** The amount columns that take part for an amount layout. */
fun amountColumns(mode: String): List<String> =
    when (mode) {
        "single_with_indicator" -> listOf("amount", "indicator")
        "split" -> listOf("credit", "debit")
        else -> listOf("amount")
    }

/** "a, b; c" as ["a", "b", "c"]. */
fun splitValues(text: String): List<String> = text.split(',', ';').map { it.trim() }.filter { it.isNotEmpty() }

/** The names or indexes a column reference of a profile holds: a string, a number or a list of them. */
fun columnRefs(element: JsonElement?): List<String> =
    when (element) {
        null, JsonNull -> emptyList()
        is JsonPrimitive -> listOf(element.content)
        is JsonArray -> element.flatMap { columnRefs(it) }
        else -> emptyList()
    }

/**
 * What the mapping form edits. [base] is the profile the form started from: everything the form has no field for (the two
 * digit year pivot, the original amount columns) is kept as it was when the profile is built.
 */
data class MappingForm(
    val delimiter: String = "auto",
    val encoding: String = "auto",
    val headerRow: String = "1",
    val skipFooterRows: String = "0",
    val dateFormat: String = "YYYY-MM-DD",
    val decimalSeparator: String = ".",
    val thousandsSeparator: String = "",
    val amountMode: String = "single",
    val invertSign: Boolean = false,
    val creditValues: String = DEFAULT_CREDIT.joinToString(", "),
    val debitValues: String = DEFAULT_DEBIT.joinToString(", "),
    val defaultCurrency: String = "",
    val columns: Map<String, String> = emptyMap(),
    val description: List<String> = emptyList(),
    val base: JsonObject = JsonObject(emptyMap()),
) {
    val headerRowValue: Int? get() = headerRow.trim().toIntOrNull()?.takeIf { it >= 0 }
    val footerRowsValue: Int? get() = skipFooterRows.trim().toIntOrNull()?.takeIf { it >= 0 }

    /** True when the file is addressed by column number: there is no header line. */
    val byIndex: Boolean get() = headerRowValue == 0
    val layoutValid: Boolean get() = headerRowValue != null && footerRowsValue != null

    fun column(key: String): String = columns[key].orEmpty()

    fun withColumn(
        key: String,
        value: String,
    ): MappingForm = copy(columns = columns + (key to value))

    fun withDescription(
        key: String,
        on: Boolean,
    ): MappingForm = copy(description = if (on) (description + key).distinct() else description - key)

    /** The profile object the server validates and saves. */
    fun toProfile(): JsonObject {
        val baseColumns = base["columns"] as? JsonObject ?: JsonObject(emptyMap())
        val active = amountColumns(amountMode)
        val columnsOut = LinkedHashMap<String, JsonElement>(baseColumns)
        for (key in MANAGED_COLUMNS) {
            val on = key !in AMOUNT_COLUMNS || key in active
            val value = column(key)
            if (on && value.isNotEmpty()) columnsOut[key] = JsonPrimitive(value) else columnsOut.remove(key)
        }
        if (description.isNotEmpty()) {
            columnsOut["description"] =
                JsonArray(
                    description.map {
                        JsonPrimitive(it)
                    },
                )
        } else {
            columnsOut.remove("description")
        }

        val out = LinkedHashMap<String, JsonElement>(base)
        out["delimiter"] = JsonPrimitive(delimiter)
        out["encoding"] = JsonPrimitive(encoding)
        out["headerRow"] = JsonPrimitive(headerRowValue ?: 1)
        out["skipFooterRows"] = JsonPrimitive(footerRowsValue ?: 0)
        out["dateFormat"] = JsonPrimitive(dateFormat)
        out["decimalSeparator"] = JsonPrimitive(decimalSeparator)
        out["thousandsSeparator"] = JsonPrimitive(thousandsSeparator)
        out["amountMode"] = JsonPrimitive(amountMode)
        out["invertSign"] = JsonPrimitive(invertSign)
        out["columns"] = JsonObject(columnsOut)
        val credit = splitValues(creditValues)
        val debit = splitValues(debitValues)
        if (amountMode == "single_with_indicator") {
            if (credit.isNotEmpty()) {
                out["indicatorCreditValues"] =
                    JsonArray(
                        credit.map { JsonPrimitive(it) },
                    )
            } else {
                out.remove("indicatorCreditValues")
            }
            if (debit.isNotEmpty()) {
                out["indicatorDebitValues"] =
                    JsonArray(
                        debit.map { JsonPrimitive(it) },
                    )
            } else {
                out.remove("indicatorDebitValues")
            }
        } else {
            out.remove("indicatorCreditValues")
            out.remove("indicatorDebitValues")
        }
        val currency = defaultCurrency.trim()
        if (currency.isNotEmpty()) out["defaultCurrency"] = JsonPrimitive(currency) else out.remove("defaultCurrency")
        return JsonObject(out)
    }

    /** The body of the live preview request. */
    fun previewBody(): String = buildJsonObject { put("profile", toProfile()) }.toString()

    companion object {
        /** The form for a profile (the draft of the page, or the mapping of another account). */
        fun fromProfile(profile: JsonObject): MappingForm {
            fun text(key: String): String? = (profile[key] as? JsonPrimitive)?.content
            val columnsObject = profile["columns"] as? JsonObject ?: JsonObject(emptyMap())
            return MappingForm(
                delimiter = text("delimiter") ?: "auto",
                encoding = text("encoding") ?: "auto",
                headerRow = text("headerRow") ?: "1",
                skipFooterRows = text("skipFooterRows") ?: "0",
                dateFormat = text("dateFormat") ?: "YYYY-MM-DD",
                decimalSeparator = text("decimalSeparator") ?: ".",
                thousandsSeparator = text("thousandsSeparator") ?: "",
                amountMode = text("amountMode") ?: "single",
                invertSign = text("invertSign") == "true",
                creditValues = columnRefs(profile["indicatorCreditValues"]).ifEmpty { DEFAULT_CREDIT }.joinToString(", "),
                debitValues = columnRefs(profile["indicatorDebitValues"]).ifEmpty { DEFAULT_DEBIT }.joinToString(", "),
                defaultCurrency = text("defaultCurrency") ?: "",
                columns = MANAGED_COLUMNS.associateWith { columnRefs(columnsObject[it]).firstOrNull().orEmpty() },
                description = columnRefs(columnsObject["description"]),
                base = profile,
            )
        }
    }
}

/** What the screen shows of the file for the current form: the answer of the page, or of the live preview. */
data class MappingView(
    val detected: List<ImportDetectedColumn>,
    val sampleRows: List<List<String>>,
    val preview: List<ImportPreviewRow>,
    val errors: List<String>,
    val valid: Boolean,
    val rowCount: Int,
    val dataRowCount: Int,
) {
    val okRows: Int get() = preview.count { it.transaction != null }
    val badRows: Int get() = preview.count { it.error != null }
}

fun ImportMappingPage.toView(): MappingView =
    MappingView(
        detected = detected,
        sampleRows = sampleRows,
        preview = preview,
        errors = errors,
        valid = profile != null && profile != JsonNull,
        rowCount = rowCount,
        dataRowCount = dataRowCount,
    )

/** How a column is addressed in the profile: by its name, or by its 0-based index when the file has no header line. */
fun columnKey(
    column: ImportDetectedColumn,
    byIndex: Boolean,
): String = if (byIndex) column.index.toString() else column.name

private fun sameColumn(
    a: String,
    b: String,
): Boolean = a.trim().equals(b.trim(), ignoreCase = true)

/** The detected column a profile value (a name or an index) points to. */
fun findColumn(
    detected: List<ImportDetectedColumn>,
    value: String,
    byIndex: Boolean,
): ImportDetectedColumn? = if (value.isEmpty()) null else detected.firstOrNull { sameColumn(columnKey(it, byIndex), value) }

/** The text of a column in the list: its name, or "Column 3" for one without. */
fun columnLabel(
    column: ImportDetectedColumn,
    byIndex: Boolean,
    numbered: (Int) -> String,
): String = if (byIndex || column.name.isEmpty()) numbered(column.index + 1) else column.name

/** The options of a column dropdown: "none" first, the value itself when the file has no such column, then the file's columns. */
fun columnOptions(
    detected: List<ImportDetectedColumn>,
    value: String,
    byIndex: Boolean,
    noneLabel: String,
    numbered: (Int) -> String,
): List<Choice> =
    buildList {
        add(Choice("", noneLabel))
        if (value.isNotEmpty() && findColumn(detected, value, byIndex) == null) add(Choice(value, value))
        detected.forEach { add(Choice(columnKey(it, byIndex), columnLabel(it, byIndex, numbered))) }
    }

/** True when a column is set that the file does not have. */
fun isUnknownColumn(
    detected: List<ImportDetectedColumn>,
    value: String,
    byIndex: Boolean,
): Boolean = value.isNotEmpty() && findColumn(detected, value, byIndex) == null

/** A few values of a column, "e.g. -4.50 · -80.00", empty when there are none. */
fun columnSample(
    detected: List<ImportDetectedColumn>,
    value: String,
    byIndex: Boolean,
): String? =
    findColumn(detected, value, byIndex)
        ?.samples
        ?.filter { it.isNotEmpty() }
        ?.joinToString(" · ")
        ?.takeIf { it.isNotEmpty() }

/**
 * Writes the column names of the form the way the file spells them (the profile matches names without regard to case, the
 * dropdowns do not).
 */
fun normalizeColumns(
    form: MappingForm,
    detected: List<ImportDetectedColumn>,
): MappingForm {
    val byIndex = form.byIndex
    val columns =
        form.columns.mapValues { (_, value) ->
            findColumn(detected, value, byIndex)?.let { columnKey(it, byIndex) } ?: value
        }
    val description = form.description.map { value -> findColumn(detected, value, byIndex)?.let { columnKey(it, byIndex) } ?: value }
    return if (columns == form.columns && description == form.description) form else form.copy(columns = columns, description = description)
}

/** A mapping copied from another account: its currency is the one of this account. */
fun copiedForm(
    profile: JsonObject,
    accountCurrency: String,
): MappingForm = MappingForm.fromProfile(profile).copy(defaultCurrency = accountCurrency)
