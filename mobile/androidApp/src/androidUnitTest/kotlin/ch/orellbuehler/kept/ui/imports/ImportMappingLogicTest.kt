package ch.orellbuehler.kept.ui.imports

import ch.orellbuehler.kept.model.ImportDetectedColumn
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ImportMappingLogicTest {
    private fun profile(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private val detected =
        listOf(
            ImportDetectedColumn(0, "Date", listOf("2024-08-02")),
            ImportDetectedColumn(1, "Details", listOf("Coffee", "")),
            ImportDetectedColumn(2, "", listOf("-4.50", "-80.00")),
        )

    private val saved =
        profile(
            """
            {"delimiter":";","encoding":"utf-8","headerRow":2,"skipFooterRows":1,"dateFormat":"DD.MM.YYYY","twoDigitYearPivot":70,
             "decimalSeparator":",","thousandsSeparator":"'","amountMode":"split","invertSign":true,
             "indicatorCreditValues":["X"],"defaultCurrency":"EUR",
             "columns":{"bookingDate":"Datum","credit":"Haben","debit":"Soll","description":["Text","Zusatz"],
                        "originalAmount":"Orig","originalCurrency":"OrigCur"}}
            """.trimIndent(),
        )

    @Test
    fun aSavedProfileFillsTheForm() {
        val form = MappingForm.fromProfile(saved)
        assertEquals(";", form.delimiter)
        assertEquals("utf-8", form.encoding)
        assertEquals("2", form.headerRow)
        assertEquals("1", form.skipFooterRows)
        assertEquals("DD.MM.YYYY", form.dateFormat)
        assertEquals(",", form.decimalSeparator)
        assertEquals("'", form.thousandsSeparator)
        assertEquals("split", form.amountMode)
        assertTrue(form.invertSign)
        assertEquals("X", form.creditValues)
        assertEquals("DBIT, Debit, DR, D", form.debitValues)
        assertEquals("EUR", form.defaultCurrency)
        assertEquals("Haben", form.column("credit"))
        assertEquals("", form.column("amount"))
        assertEquals(listOf("Text", "Zusatz"), form.description)
        assertEquals(2, form.headerRowValue)
        assertFalse(form.byIndex)
    }

    @Test
    fun anEmptyProfileGetsTheWebDefaults() {
        val form = MappingForm.fromProfile(profile("{}"))
        assertEquals("auto", form.delimiter)
        assertEquals("1", form.headerRow)
        assertEquals("0", form.skipFooterRows)
        assertEquals("YYYY-MM-DD", form.dateFormat)
        assertEquals(".", form.decimalSeparator)
        assertEquals("", form.thousandsSeparator)
        assertEquals("single", form.amountMode)
        assertEquals("CRDT, Credit, CR, C", form.creditValues)
        assertTrue(form.description.isEmpty())
    }

    @Test
    fun theProfileKeepsWhatTheFormHasNoFieldFor() {
        val out = MappingForm.fromProfile(saved).toProfile()
        assertEquals(JsonPrimitive(70), out["twoDigitYearPivot"])
        val columns = out["columns"] as JsonObject
        assertEquals(JsonPrimitive("Orig"), columns["originalAmount"])
        assertEquals(JsonPrimitive("OrigCur"), columns["originalCurrency"])
        assertEquals(JsonPrimitive("Haben"), columns["credit"])
        assertEquals(JsonArray(listOf(JsonPrimitive("Text"), JsonPrimitive("Zusatz"))), columns["description"])
        assertEquals(JsonPrimitive(2), out["headerRow"])
        assertEquals(JsonPrimitive(true), out["invertSign"])
        assertEquals(JsonPrimitive("EUR"), out["defaultCurrency"])
    }

    @Test
    fun onlyTheColumnsOfTheAmountLayoutAreSent() {
        val form = MappingForm.fromProfile(saved)
        val single = form.copy(amountMode = "single").withColumn("amount", "Betrag")
        val columns = single.toProfile()["columns"] as JsonObject
        assertEquals(JsonPrimitive("Betrag"), columns["amount"])
        assertNull(columns["credit"])
        assertNull(columns["debit"])
        assertNull(columns["indicator"])
        val split = single.copy(amountMode = "split").toProfile()["columns"] as JsonObject
        assertNull(split["amount"])
        assertEquals(JsonPrimitive("Haben"), split["credit"])
    }

    @Test
    fun indicatorValuesAreSentOnlyForTheIndicatorLayout() {
        val form =
            MappingForm
                .fromProfile(
                    saved,
                ).copy(amountMode = "single_with_indicator", creditValues = "C; Credit , ", debitValues = "")
        val indicator = form.toProfile()
        assertEquals(JsonArray(listOf(JsonPrimitive("C"), JsonPrimitive("Credit"))), indicator["indicatorCreditValues"])
        assertNull(indicator["indicatorDebitValues"])
        val split = form.copy(amountMode = "split").toProfile()
        assertNull(split["indicatorCreditValues"])
    }

    @Test
    fun anEmptyCurrencyIsLeftOutAndALayoutErrorFallsBack() {
        val form = MappingForm.fromProfile(saved).copy(defaultCurrency = " ", headerRow = "x", skipFooterRows = "-1")
        val out = form.toProfile()
        assertNull(out["defaultCurrency"])
        assertEquals(JsonPrimitive(1), out["headerRow"])
        assertEquals(JsonPrimitive(0), out["skipFooterRows"])
        assertFalse(form.layoutValid)
        assertTrue(form.copy(headerRow = "0", skipFooterRows = "0").layoutValid)
    }

    @Test
    fun theDescriptionColumnsCanBeTicked() {
        val form = MappingForm().withDescription("Text", true).withDescription("Text", true).withDescription("Zusatz", true)
        assertEquals(listOf("Text", "Zusatz"), form.description)
        assertEquals(listOf("Zusatz"), form.withDescription("Text", false).description)
        assertNull((MappingForm().toProfile()["columns"] as JsonObject)["description"])
    }

    @Test
    fun columnsAreAddressedByNameOrByIndex() {
        assertEquals("Date", columnKey(detected[0], false))
        assertEquals("0", columnKey(detected[0], true))
        assertEquals("Date", findColumn(detected, " date ", false)?.name)
        assertEquals("Details", findColumn(detected, "1", true)?.name)
        assertNull(findColumn(detected, "", false))
        assertNull(findColumn(detected, "Missing", false))
        assertEquals("Column 3", columnLabel(detected[2], false) { "Column $it" })
        assertEquals("Column 1", columnLabel(detected[0], true) { "Column $it" })
        assertEquals("Date", columnLabel(detected[0], false) { "Column $it" })
    }

    @Test
    fun theDropdownOffersAnUnknownValueSoItStaysVisible() {
        val options = columnOptions(detected, "Gone", false, "none") { "Column $it" }
        assertEquals(listOf("", "Gone", "Date", "Details", ""), options.map { it.value })
        assertEquals("Column 3", options.last().label)
        assertTrue(isUnknownColumn(detected, "Gone", false))
        assertFalse(isUnknownColumn(detected, "date", false))
        assertFalse(isUnknownColumn(detected, "", false))
        assertEquals(listOf("", "Date", "Details", ""), columnOptions(detected, "date", false, "none") { "Column $it" }.map { it.value })
    }

    @Test
    fun aSampleShowsTheValuesOfTheChosenColumn() {
        assertEquals("-4.50 · -80.00", columnSample(detected, "2", true))
        assertEquals("Coffee", columnSample(detected, "details", false))
        assertNull(columnSample(detected, "", false))
        assertNull(columnSample(detected, "Missing", false))
    }

    @Test
    fun namesAreWrittenAsTheFileSpellsThem() {
        val form = MappingForm().withColumn("bookingDate", "date").withColumn("amount", "Other").withDescription("DETAILS", true)
        val fixed = normalizeColumns(form, detected)
        assertEquals("Date", fixed.column("bookingDate"))
        assertEquals("Other", fixed.column("amount"))
        assertEquals(listOf("Details"), fixed.description)
        assertEquals(fixed, normalizeColumns(fixed, detected))
    }

    @Test
    fun aCopiedMappingTakesTheCurrencyOfTheAccount() {
        val copied = copiedForm(saved, "CHF")
        assertEquals("CHF", copied.defaultCurrency)
        assertEquals("Haben", copied.column("credit"))
        assertEquals(JsonPrimitive(70), copied.toProfile()["twoDigitYearPivot"])
    }

    @Test
    fun theLivePreviewBodyWrapsTheProfile() {
        val body = profile(MappingForm.fromProfile(saved).previewBody())
        assertEquals(setOf("profile"), body.keys)
        assertEquals(JsonPrimitive("split"), (body["profile"] as JsonObject)["amountMode"])
    }

    @Test
    fun columnReferencesAreStringsNumbersOrLists() {
        assertEquals(listOf("A"), columnRefs(JsonPrimitive("A")))
        assertEquals(listOf("3"), columnRefs(JsonPrimitive(3)))
        assertEquals(listOf("A", "4"), columnRefs(JsonArray(listOf(JsonPrimitive("A"), JsonPrimitive(4)))))
        assertTrue(columnRefs(null).isEmpty())
        assertEquals(listOf("a", "b", "c"), splitValues("a, b;c ,"))
    }
}
