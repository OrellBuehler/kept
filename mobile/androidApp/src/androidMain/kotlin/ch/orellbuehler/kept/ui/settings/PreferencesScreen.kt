package ch.orellbuehler.kept.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.PreferencesPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.nav.Navigator

class PreferencesViewModel(
    sdk: KeptSdk,
) : PageViewModel<PreferencesPage>(sdk, { it.load("settings/preferences") }) {
    /** Saves the form; [savedMessage] is shown once the server took it. */
    fun save(
        values: PreferencesFormValues,
        savedMessage: String,
    ) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        submit("settings/preferences", "save", form, showRefusal = true) { message(savedMessage) }
    }
}

/** How IBANs, amounts and dates are shown, the default currency and the page size. */
@Composable
fun PreferencesScreen(nav: Navigator) {
    val vm = keptViewModel { PreferencesViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val saved = stringResource(R.string.preferences_saved)
    PageScaffold(
        title = stringResource(R.string.preferences_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
    ) { page, padding ->
        val initial = PreferencesFormValues.of(page.preferences)
        var ibanDisplay by rememberSaveable { mutableStateOf(initial.ibanDisplay) }
        var blur by rememberSaveable { mutableStateOf(initial.blurAmounts) }
        var locale by rememberSaveable { mutableStateOf(initial.locale) }
        var currency by rememberSaveable { mutableStateOf(initial.defaultCurrency) }
        var pageSize by rememberSaveable { mutableStateOf(initial.pageSize) }
        var cashLiquid by rememberSaveable { mutableStateOf(initial.investmentCashLiquid) }
        val values = PreferencesFormValues(ibanDisplay, blur, locale, currency, pageSize, cashLiquid)
        ScrollColumn(padding) {
            SectionCard(
                title = stringResource(R.string.preferences_privacy),
                subtitle = stringResource(R.string.preferences_privacy_text),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.preferences_iban), style = MaterialTheme.typography.labelLarge)
                    IBAN_DISPLAYS.forEach { option ->
                        val (label, hint) = ibanOption(option)
                        Row(
                            Modifier.fillMaxWidth().clickable { ibanDisplay = option }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.Top,
                        ) {
                            RadioButton(selected = ibanDisplay == option, onClick = { ibanDisplay = option })
                            Column(Modifier.weight(1f).padding(top = 12.dp)) {
                                Text(stringResource(label), style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    stringResource(hint),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    errors["ibanDisplay"]?.let {
                        Text(
                            it,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Text(
                        stringResource(R.string.preferences_iban_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    SwitchRow(
                        title = stringResource(R.string.preferences_blur),
                        subtitle = stringResource(R.string.preferences_blur_text),
                        checked = blur,
                        onCheckedChange = { blur = it },
                    )
                }
            }

            SectionCard(
                title = stringResource(R.string.preferences_display),
                subtitle = stringResource(R.string.preferences_display_text),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ChoiceField(
                        label = stringResource(R.string.preferences_locale),
                        options = PREFERENCE_LOCALES.map { Choice(it.first, it.second) },
                        selected = locale,
                        onSelect = { locale = it },
                        error = errors["locale"],
                    )
                    Text(
                        stringResource(R.string.preferences_example, values.example()),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    ChoiceField(
                        label = stringResource(R.string.preferences_currency),
                        options = PREFERENCE_CURRENCIES.map { Choice(it, it) },
                        selected = currency,
                        onSelect = { currency = it },
                        error = errors["defaultCurrency"],
                    )
                    Text(
                        stringResource(R.string.preferences_currency_text),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    ChoiceField(
                        label = stringResource(R.string.preferences_page_size),
                        options = PREFERENCE_PAGE_SIZES.map { Choice(it.toString(), it.toString()) },
                        selected = pageSize,
                        onSelect = { pageSize = it },
                        error = errors["pageSize"],
                    )
                }
            }

            SectionCard(
                title = stringResource(R.string.preferences_liquidity),
                subtitle = stringResource(R.string.preferences_liquidity_text),
            ) {
                SwitchRow(
                    title = stringResource(R.string.preferences_cash_liquid),
                    subtitle = stringResource(R.string.preferences_cash_liquid_text),
                    checked = cashLiquid,
                    onCheckedChange = { cashLiquid = it },
                )
            }

            errors["form"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(onClick = { vm.save(values, saved) }, enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(R.string.preferences_save))
                }
            }
        }
    }
}

private fun ibanOption(value: String): Pair<Int, Int> =
    when (value) {
        "masked" -> R.string.preferences_iban_masked to R.string.preferences_iban_masked_text
        "hidden" -> R.string.preferences_iban_hidden to R.string.preferences_iban_hidden_text
        else -> R.string.preferences_iban_full to R.string.preferences_iban_full_text
    }
