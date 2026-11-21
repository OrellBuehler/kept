package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.Preferences
import ch.orellbuehler.kept.ui.common.Formats

val IBAN_DISPLAYS = listOf("full", "masked", "hidden")

/** The formats Kept offers (`LOCALES` of the web) with the name each is shown under. */
val PREFERENCE_LOCALES =
    listOf(
        "en-GB" to "English (UK)",
        "de-CH" to "Deutsch (Schweiz)",
        "de-DE" to "Deutsch (Deutschland)",
        "fr-CH" to "Français (Suisse)",
        "en-US" to "English (US)",
    )

val PREFERENCE_CURRENCIES = listOf("CHF", "EUR", "USD", "GBP")

val PREFERENCE_PAGE_SIZES = listOf(25, 50, 100, 200)

/** What the preferences form holds. */
data class PreferencesFormValues(
    val ibanDisplay: String = "full",
    val blurAmounts: Boolean = false,
    val locale: String = "en-GB",
    val defaultCurrency: String = "CHF",
    val pageSize: String = "50",
    val investmentCashLiquid: Boolean = false,
) {
    /** The fields of the `save` action; a switch that is off is left out, like an unticked checkbox. */
    fun fields(): List<Pair<String, String>> =
        buildList {
            add("ibanDisplay" to ibanDisplay)
            if (blurAmounts) add("blurAmounts" to "on")
            add("locale" to locale)
            add("defaultCurrency" to defaultCurrency)
            add("pageSize" to pageSize)
            if (investmentCashLiquid) add("investmentCashLiquid" to "on")
        }

    /** "CHF 1’234.50 · 31 Mar 2024" in the chosen format, to show what the choice does. */
    fun example(): String {
        val formats = Formats(locale)
        return "${formats.money(123450, "CHF")} · ${formats.date("2024-03-31")}"
    }

    companion object {
        fun of(preferences: Preferences): PreferencesFormValues =
            PreferencesFormValues(
                ibanDisplay = preferences.ibanDisplay,
                blurAmounts = preferences.blurAmounts,
                locale = preferences.locale,
                defaultCurrency = preferences.defaultCurrency,
                pageSize = preferences.pageSize.toString(),
                investmentCashLiquid = preferences.investmentCashLiquid,
            )
    }
}
