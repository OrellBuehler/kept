package ch.orellbuehler.kept.ui.settings

import android.content.res.Resources
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.MarketDataPage
import ch.orellbuehler.kept.model.MarketDataRefresh
import ch.orellbuehler.kept.model.MarketDataRefreshAnswer
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.KeyValueRow
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.imports.formatDateTime
import ch.orellbuehler.kept.ui.nav.Navigator

private const val PAGE = "settings/market-data"

class MarketDataViewModel(
    sdk: KeptSdk,
) : PageViewModel<MarketDataPage>(sdk, { it.load(PAGE) }) {
    fun save(
        enabled: Boolean,
        savedMessage: String,
    ) {
        val form = FormBody()
        marketDataFields(enabled).forEach { (name, value) -> form.set(name, value) }
        submit(PAGE, "save", form, showRefusal = true) { message(savedMessage) }
    }

    /** Fetches prices and rates now; [describe] turns what was fetched into the message to show. */
    fun refreshPrices(describe: (MarketDataRefresh) -> String) {
        submit(PAGE, "refresh", showRefusal = true) { response ->
            val answer = runCatching { ApiJson.decodeFromString<MarketDataRefreshAnswer>(response.json) }.getOrNull()
            if (answer != null) message(describe(answer.result))
        }
    }
}

private fun refreshSummary(
    resources: Resources,
    result: MarketDataRefresh,
): String {
    val securities = resources.getQuantityString(R.plurals.market_data_securities, result.securities, result.securities)
    val pairs = resources.getQuantityString(R.plurals.market_data_pairs, result.fxPairs, result.fxPairs)
    val summary = resources.getString(R.string.market_data_updated, securities, pairs, result.prices, result.fxRates)
    if (result.errors.isEmpty()) return summary
    return summary + " " + resources.getQuantityString(R.plurals.market_data_failed, result.errors.size, result.errors.size)
}

/** Whether Kept fetches prices for the securities, and a button to do it now. */
@Composable
fun MarketDataScreen(nav: Navigator) {
    val vm = keptViewModel { MarketDataViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val resources = LocalContext.current.resources
    val saved = stringResource(R.string.market_data_saved)
    var working by remember { mutableStateOf("") }
    PageScaffold(
        title = stringResource(R.string.market_data_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
    ) { page, padding ->
        var enabled by rememberSaveable { mutableStateOf(page.settings.enabled) }
        val formats = LocalFormats.current
        ScrollColumn(padding) {
            SectionCard(title = stringResource(R.string.market_data_title), subtitle = stringResource(R.string.market_data_text)) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SwitchRow(stringResource(R.string.market_data_enable), enabled, { enabled = it })
                    if (!page.providerAvailable) {
                        Text(
                            stringResource(R.string.market_data_no_provider),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(stringResource(R.string.market_data_leaves), style = MaterialTheme.typography.bodyMedium)
                    listOf(
                        R.string.market_data_leaves_symbols,
                        R.string.market_data_leaves_lookup,
                        R.string.market_data_leaves_ip,
                    ).forEach {
                        Text(
                            "• " + stringResource(it),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        stringResource(R.string.market_data_never),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(
                        onClick = {
                            working = "save"
                            vm.save(enabled, saved)
                        },
                        enabled = !busy,
                    ) {
                        if (busy && working == "save") {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        } else {
                            Text(stringResource(R.string.save))
                        }
                    }
                }
            }
            SectionCard(
                title = stringResource(R.string.market_data_refresh),
                subtitle = stringResource(R.string.market_data_refresh_text),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    KeyValueRow(
                        stringResource(R.string.market_data_last_run),
                        page.settings.lastRunAt?.let { formatDateTime(it, formats.locale) }
                            ?: stringResource(R.string.market_data_never_run),
                    )
                    KeyValueRow(
                        stringResource(R.string.market_data_last_error),
                        page.settings.lastError?.takeIf { it.isNotBlank() } ?: stringResource(R.string.none),
                    )
                    OutlinedButton(
                        onClick = {
                            working = "refresh"
                            vm.refreshPrices { refreshSummary(resources, it) }
                        },
                        enabled = !busy && canRefresh(page),
                    ) {
                        if (busy && working == "refresh") {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.market_data_refresh_now), modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                    if (!page.settings.enabled) {
                        Text(
                            stringResource(R.string.market_data_turn_on),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
