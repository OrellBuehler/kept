package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.Preferences
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PreferencesLogicTest {
    @Test
    fun theFormStartsWithTheSavedPreferences() {
        val form = PreferencesFormValues.of(Preferences("masked", true, "de-CH", "EUR", 100, true))
        assertEquals(PreferencesFormValues("masked", true, "de-CH", "EUR", "100", true), form)
    }

    @Test
    fun switchesThatAreOffAreLeftOutLikeAnUntickedCheckbox() {
        val off = PreferencesFormValues("full", false, "en-GB", "CHF", "50", false)
        assertEquals(
            listOf("ibanDisplay" to "full", "locale" to "en-GB", "defaultCurrency" to "CHF", "pageSize" to "50"),
            off.fields(),
        )
        val on = off.copy(blurAmounts = true, investmentCashLiquid = true)
        assertEquals(
            listOf(
                "ibanDisplay" to "full",
                "blurAmounts" to "on",
                "locale" to "en-GB",
                "defaultCurrency" to "CHF",
                "pageSize" to "50",
                "investmentCashLiquid" to "on",
            ),
            on.fields(),
        )
    }

    @Test
    fun theExampleFollowsTheChosenFormat() {
        val british = PreferencesFormValues(locale = "en-GB").example()
        assertTrue(british.contains("1,234.50"), british)
        assertTrue(british.contains("31 Mar 2024"), british)
        val german = PreferencesFormValues(locale = "de-DE").example()
        assertTrue(german.contains("1.234,50"), german)
    }

    @Test
    fun theChoicesAreTheOnesTheServerAccepts() {
        assertEquals(listOf("full", "masked", "hidden"), IBAN_DISPLAYS)
        assertEquals(listOf("en-GB", "de-CH", "de-DE", "fr-CH", "en-US"), PREFERENCE_LOCALES.map { it.first })
        assertEquals(listOf(25, 50, 100, 200), PREFERENCE_PAGE_SIZES)
        assertEquals(listOf("CHF", "EUR", "USD", "GBP"), PREFERENCE_CURRENCIES)
    }
}
