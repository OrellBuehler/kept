package ch.orellbuehler.kept.ui.settings

import ch.orellbuehler.kept.model.MarketDataPage

/** The prices can be fetched now: the feature is on and this installation has a provider. */
fun canRefresh(page: MarketDataPage): Boolean = page.settings.enabled && page.providerAvailable

/** The fields of `save`: the switch is sent as a checkbox, so it is left out when off. */
fun marketDataFields(enabled: Boolean): List<Pair<String, String>> = if (enabled) listOf("enabled" to "on") else emptyList()
