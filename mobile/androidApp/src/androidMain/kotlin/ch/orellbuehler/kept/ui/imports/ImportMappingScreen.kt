package ch.orellbuehler.kept.ui.imports

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ImportMappingPage
import ch.orellbuehler.kept.model.ImportOtherProfile
import ch.orellbuehler.kept.model.ImportPreviewRow
import ch.orellbuehler.kept.model.decodePage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.nav.Navigator
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the live preview last answered: [view] replaces the page's own until the user edits nothing more. */
data class MappingLive(
    val view: MappingView? = null,
    val loading: Boolean = false,
    val error: String? = null,
)

private const val PREVIEW_DELAY_MS = 300L

class ImportMappingViewModel(
    sdk: KeptSdk,
    private val pendingId: String,
    private val formFlow: MutableStateFlow<MappingForm?> = MutableStateFlow(null),
    private val liveFlow: MutableStateFlow<MappingLive> = MutableStateFlow(MappingLive()),
) : PageViewModel<ImportMappingPage>(
        sdk,
        { s ->
            s.load<ImportMappingPage>("import/$pendingId/mapping").also { page ->
                if (formFlow.value == null) formFlow.value = MappingForm.fromProfile(page.draft)
            }
        },
    ) {
    val form: StateFlow<MappingForm?> = formFlow.asStateFlow()
    val live: StateFlow<MappingLive> = liveFlow.asStateFlow()

    private var previewJob: Job? = null

    fun edit(change: (MappingForm) -> MappingForm) {
        val current = formFlow.value ?: return
        val next = change(current)
        if (next == current) return
        formFlow.value = next
        schedulePreview()
    }

    fun apply(
        other: ImportOtherProfile,
        currency: String,
    ) {
        formFlow.value = copiedForm(other.profile, currency)
        schedulePreview()
    }

    private fun schedulePreview() {
        previewJob?.cancel()
        liveFlow.update { it.copy(loading = true) }
        previewJob =
            viewModelScope.launch {
                delay(PREVIEW_DELAY_MS)
                val body = formFlow.value?.previewBody() ?: return@launch
                try {
                    val result = decodePage<ImportMappingPage>(sdk.endpoint("imports/$pendingId/preview", jsonBody = body))
                    liveFlow.value = MappingLive(view = result.toView(), loading = false, error = null)
                    formFlow.update { current -> current?.let { normalizeColumns(it, result.detected) } }
                } catch (e: KeptException) {
                    liveFlow.update { it.copy(loading = false, error = e.message.orEmpty()) }
                }
            }
    }

    fun save(name: String) {
        val current = formFlow.value ?: return
        submit(
            "import/$pendingId/mapping",
            "save",
            FormBody().set("name", name.trim()).set("profile", current.toProfile().toString()),
            reload = false,
        )
    }
}

/** Tells the server which column of a CSV or Excel file is the date, the amount and so on. */
@Composable
fun ImportMappingScreen(
    pendingId: String,
    nav: Navigator,
) {
    val vm = keptViewModel(key = "mapping-$pendingId") { ImportMappingViewModel(it, pendingId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val form by vm.form.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    var name by rememberSaveable { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    PageScaffold(
        title = stringResource(R.string.imports_mapping_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event -> if (event is UiEvent.Navigate) nav.openWebPath(event.webPath, replace = true) },
    ) { page, padding ->
        val current = form
        if (current == null) return@PageScaffold
        val view = live.view ?: page.toView()
        val defaultName = stringResource(R.string.imports_mapping_default_name, page.account.name)
        val profileName = name ?: page.savedName ?: defaultName
        val canSave = view.valid && live.error == null && current.layoutValid && !live.loading && profileName.isNotBlank()
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(padding),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Header(page, view)
                Problems(view, live)
                SecondaryTabRow(selectedTabIndex = tab) {
                    listOf(R.string.imports_mapping_tab_mapping, R.string.imports_mapping_tab_preview, R.string.imports_mapping_tab_file)
                        .forEachIndexed { index, label ->
                            Tab(selected = tab == index, onClick = { tab = index }, text = { Text(stringResource(label), maxLines = 1) })
                        }
                }
                when (tab) {
                    0 -> MappingTab(page, current, view, vm, profileName, onName = { name = it }, errors)
                    1 -> PreviewTab(view, live.loading)
                    else -> FileTab(view, current)
                }
            }
            SaveBar(
                enabled = canSave && !busy,
                busy = busy,
                error = errors["form"] ?: errors["profile"],
                onSave = { vm.save(profileName) },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

@Composable
private fun Header(
    page: ImportMappingPage,
    view: MappingView,
) {
    SectionCard(
        title = page.fileName,
        subtitle =
            stringResource(
                R.string.imports_mapping_subtitle,
                page.account.name,
                page.account.currency,
                pluralStringResource(R.plurals.imports_mapping_rows, view.dataRowCount, view.dataRowCount),
            ),
        trailing = { Pill(formatName(page.format)) },
    ) {
        Text(
            stringResource(R.string.imports_mapping_explain),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Problems(
    view: MappingView,
    live: MappingLive,
) {
    if (live.error == null && view.errors.isEmpty()) return
    SectionCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (live.error != null) {
                    Text(stringResource(R.string.imports_mapping_preview_unavailable), style = MaterialTheme.typography.titleSmall)
                    Text(live.error, style = MaterialTheme.typography.bodyMedium)
                }
                if (view.errors.isNotEmpty()) {
                    Text(stringResource(R.string.imports_mapping_invalid), style = MaterialTheme.typography.titleSmall)
                    view.errors.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
    }
}

@Composable
private fun MappingTab(
    page: ImportMappingPage,
    form: MappingForm,
    view: MappingView,
    vm: ImportMappingViewModel,
    profileName: String,
    onName: (String) -> Unit,
    errors: Map<String, String>,
) {
    val edit = vm::edit
    val numbered = columnNamer()
    if (page.otherProfiles.isNotEmpty()) CopyCard(page, vm)

    SectionCard(title = stringResource(R.string.imports_mapping_layout)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (page.format != "xlsx") {
                ChoiceField(
                    label = stringResource(R.string.imports_mapping_delimiter),
                    options = DELIMITERS.map { Choice(it, delimiterLabel(it)) },
                    selected = form.delimiter,
                    onSelect = { v -> edit { it.copy(delimiter = v) } },
                )
                ChoiceField(
                    label = stringResource(R.string.imports_mapping_encoding),
                    options = ENCODINGS.map { Choice(it, encodingLabel(it)) },
                    selected = form.encoding,
                    onSelect = { v -> edit { it.copy(encoding = v) } },
                )
            }
            FormTextField(
                label = stringResource(R.string.imports_mapping_header_row),
                value = form.headerRow,
                onValueChange = { v -> edit { it.copy(headerRow = v) } },
                error = if (form.headerRowValue == null) stringResource(R.string.imports_mapping_whole_number) else null,
                hint = stringResource(R.string.imports_mapping_header_row_hint),
                keyboardType = KeyboardType.Number,
            )
            FormTextField(
                label = stringResource(R.string.imports_mapping_footer_rows),
                value = form.skipFooterRows,
                onValueChange = { v -> edit { it.copy(skipFooterRows = v) } },
                error = if (form.footerRowsValue == null) stringResource(R.string.imports_mapping_whole_number) else null,
                hint = stringResource(R.string.imports_mapping_footer_rows_hint),
                keyboardType = KeyboardType.Number,
            )
        }
    }

    SectionCard(title = stringResource(R.string.imports_mapping_numbers)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ChoiceField(
                label = stringResource(R.string.imports_mapping_date_format),
                options = DATE_FORMATS.map { Choice(it, it) },
                selected = form.dateFormat,
                onSelect = { v -> edit { it.copy(dateFormat = v) } },
            )
            ChoiceField(
                label = stringResource(R.string.imports_mapping_decimal),
                options = DECIMAL_SEPARATORS.map { Choice(it, decimalLabel(it)) },
                selected = form.decimalSeparator,
                onSelect = { v -> edit { it.copy(decimalSeparator = v) } },
            )
            ChoiceField(
                label = stringResource(R.string.imports_mapping_thousands),
                options = THOUSANDS_SEPARATORS.map { Choice(it, thousandsLabel(it)) },
                selected = form.thousandsSeparator,
                onSelect = { v -> edit { it.copy(thousandsSeparator = v) } },
            )
            FormTextField(
                label = stringResource(R.string.imports_mapping_default_currency),
                value = form.defaultCurrency,
                onValueChange = { v -> edit { it.copy(defaultCurrency = v.filter { c -> c.isLetter() }.take(3).uppercase()) } },
                hint = stringResource(R.string.imports_mapping_default_currency_hint),
                placeholder = page.account.currency,
            )
        }
    }

    SectionCard(title = stringResource(R.string.imports_mapping_amount)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ChoiceField(
                label = stringResource(R.string.imports_mapping_amount_layout),
                options = AMOUNT_MODES.map { Choice(it, amountModeLabel(it)) },
                selected = form.amountMode,
                onSelect = { v -> edit { it.copy(amountMode = v) } },
            )
            val active = amountColumns(form.amountMode)
            if ("amount" in active) ColumnField("amount", R.string.imports_mapping_col_amount, form, view, edit, required = true)
            if ("indicator" in active) {
                ColumnField("indicator", R.string.imports_mapping_col_indicator, form, view, edit, required = true)
                FormTextField(
                    label = stringResource(R.string.imports_mapping_credit_values),
                    value = form.creditValues,
                    onValueChange = { v -> edit { it.copy(creditValues = v) } },
                    hint = stringResource(R.string.imports_mapping_values_hint),
                )
                FormTextField(
                    label = stringResource(R.string.imports_mapping_debit_values),
                    value = form.debitValues,
                    onValueChange = { v -> edit { it.copy(debitValues = v) } },
                    hint = stringResource(R.string.imports_mapping_values_hint),
                )
            }
            if ("credit" in active) {
                ColumnField("credit", R.string.imports_mapping_col_credit, form, view, edit)
                ColumnField("debit", R.string.imports_mapping_col_debit, form, view, edit)
            }
            SwitchRow(
                title = stringResource(R.string.imports_mapping_invert),
                subtitle = stringResource(R.string.imports_mapping_invert_hint),
                checked = form.invertSign,
                onCheckedChange = { v -> edit { it.copy(invertSign = v) } },
            )
        }
    }

    SectionCard(title = stringResource(R.string.imports_mapping_columns)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ColumnField("bookingDate", R.string.imports_mapping_col_booking, form, view, edit, required = true)
            ColumnField("valueDate", R.string.imports_mapping_col_value, form, view, edit)
            ColumnField("currency", R.string.imports_mapping_col_currency, form, view, edit)
            ColumnField("counterpartyName", R.string.imports_mapping_col_name, form, view, edit)
            ColumnField("counterpartyIban", R.string.imports_mapping_col_iban, form, view, edit)
            ColumnField("reference", R.string.imports_mapping_col_reference, form, view, edit)
            ColumnField("externalId", R.string.imports_mapping_col_external, form, view, edit)
            ColumnField("balance", R.string.imports_mapping_col_balance, form, view, edit)
            Text(stringResource(R.string.imports_mapping_description), style = MaterialTheme.typography.labelLarge)
            Text(
                stringResource(R.string.imports_mapping_description_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (view.detected.isEmpty()) {
                Text(stringResource(R.string.imports_mapping_no_columns), style = MaterialTheme.typography.bodyMedium)
            }
            view.detected.forEach { column ->
                val key = columnKey(column, form.byIndex)
                val checked = form.description.any { it.trim().equals(key.trim(), ignoreCase = true) }
                Row(
                    Modifier.fillMaxWidth().clickable { edit { f -> f.withDescription(key, !checked) } },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked = checked, onCheckedChange = { on -> edit { f -> f.withDescription(key, on) } })
                    Text(
                        columnLabel(column, form.byIndex, numbered),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
    }

    SectionCard(title = stringResource(R.string.imports_mapping_save_title)) {
        FormTextField(
            label = stringResource(R.string.imports_mapping_profile_name),
            value = profileName,
            onValueChange = { onName(it.take(80)) },
            error = errors["name"],
            hint = stringResource(R.string.imports_mapping_profile_name_hint),
        )
    }
}

/** "Column 3" for the file's third column, for a column without a name. */
@Composable
private fun columnNamer(): (Int) -> String {
    val resources = LocalContext.current.resources
    return { n -> resources.getString(R.string.imports_mapping_column_n, n) }
}

@Composable
private fun CopyCard(
    page: ImportMappingPage,
    vm: ImportMappingViewModel,
) {
    var choice by rememberSaveable { mutableStateOf("") }
    SectionCard(
        title = stringResource(R.string.imports_mapping_copy_title),
        subtitle = stringResource(R.string.imports_mapping_copy_text),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ChoiceField(
                label = stringResource(R.string.imports_mapping_copy_field),
                options = page.otherProfiles.map { Choice(it.accountId, "${it.name} (${it.accountName})") },
                selected = choice,
                onSelect = { choice = it },
            )
            OutlinedButton(
                onClick = {
                    page.otherProfiles.firstOrNull { it.accountId == choice }?.let { vm.apply(it, page.account.currency) }
                    choice = ""
                },
                enabled = choice.isNotEmpty(),
            ) { Text(stringResource(R.string.imports_mapping_copy_apply)) }
        }
    }
}

@Composable
private fun ColumnField(
    key: String,
    label: Int,
    form: MappingForm,
    view: MappingView,
    edit: ((MappingForm) -> MappingForm) -> Unit,
    required: Boolean = false,
) {
    val value = form.column(key)
    val byIndex = form.byIndex
    val none = stringResource(if (required) R.string.imports_mapping_choose_column else R.string.imports_mapping_no_column)
    val numbered = columnNamer()
    val options = columnOptions(view.detected, value, byIndex, none, numbered)
    val unknown = isUnknownColumn(view.detected, value, byIndex)
    val selected = findColumn(view.detected, value, byIndex)?.let { columnKey(it, byIndex) } ?: value
    Column {
        ChoiceField(
            label = stringResource(label),
            options = options,
            selected = selected,
            onSelect = { v -> edit { it.withColumn(key, v) } },
            error = if (unknown) stringResource(R.string.imports_mapping_unknown_column) else null,
        )
        columnSample(view.detected, value, byIndex)?.let {
            Text(
                stringResource(R.string.imports_mapping_sample, it),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 16.dp, top = 2.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun PreviewTab(
    view: MappingView,
    loading: Boolean,
) {
    SectionCard(
        title = stringResource(R.string.imports_mapping_preview),
        subtitle =
            if (view.valid) {
                stringResource(R.string.imports_mapping_preview_summary, view.okRows, view.preview.size, view.badRows)
            } else {
                stringResource(R.string.imports_mapping_preview_choose)
            },
        trailing = { if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) },
        contentPadding = false,
    ) {
        if (view.preview.isEmpty()) {
            Text(
                stringResource(R.string.imports_mapping_preview_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
            )
        }
        view.preview.forEachIndexed { index, row ->
            if (index > 0) RowDivider()
            PreviewRow(row)
        }
    }
}

@Composable
private fun PreviewRow(row: ImportPreviewRow) {
    val formats = LocalFormats.current
    val tx = row.transaction
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (tx != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(rowTitle(tx), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 2)
                AmountText(tx.amount, tx.currency, tone = AmountTone.SIGNED, showPlus = true, style = MaterialTheme.typography.bodyLarge)
            }
            rowSubtitle(tx)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
            }
            Text(
                stringResource(R.string.imports_mapping_row_line, row.rowNumber, formats.date(tx.bookingDate)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                stringResource(
                    R.string.imports_mapping_row_error,
                    row.rowNumber,
                    row.error ?: stringResource(R.string.imports_mapping_row_unreadable),
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun FileTab(
    view: MappingView,
    form: MappingForm,
) {
    SectionCard(
        title = stringResource(R.string.imports_mapping_file),
        subtitle = stringResource(R.string.imports_mapping_file_text, view.sampleRows.size, view.rowCount),
    ) {
        if (view.sampleRows.isEmpty()) {
            Text(stringResource(R.string.imports_mapping_file_empty), style = MaterialTheme.typography.bodyMedium)
        } else {
            Column(Modifier.horizontalScroll(rememberScrollState())) {
                view.sampleRows.forEachIndexed { index, cells ->
                    val header = index + 1 == form.headerRowValue
                    Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            (index + 1).toString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.width(24.dp),
                        )
                        cells.forEach { cell ->
                            Text(
                                cell,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                fontWeight = if (header) FontWeight.Bold else null,
                                color = if (header) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.width(120.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SaveBar(
    enabled: Boolean,
    busy: Boolean,
    error: String?,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(modifier.fillMaxWidth(), tonalElevation = 3.dp, shadowElevation = 3.dp) {
        Column(
            Modifier.navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!error.isNullOrBlank()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            Button(onClick = onSave, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(R.string.imports_mapping_save))
                }
            }
        }
    }
}

@Composable
private fun delimiterLabel(value: String): String =
    stringResource(
        when (value) {
            "," -> R.string.imports_mapping_delimiter_comma
            ";" -> R.string.imports_mapping_delimiter_semicolon
            "\t" -> R.string.imports_mapping_delimiter_tab
            "|" -> R.string.imports_mapping_delimiter_pipe
            else -> R.string.imports_mapping_auto
        },
    )

@Composable
private fun encodingLabel(value: String): String =
    when (value) {
        "utf-8" -> "UTF-8"
        "utf-16le" -> "UTF-16 LE"
        "windows-1252" -> "Windows-1252"
        "iso-8859-1" -> "ISO-8859-1"
        else -> stringResource(R.string.imports_mapping_auto)
    }

@Composable
private fun decimalLabel(value: String): String =
    stringResource(if (value == ",") R.string.imports_mapping_sep_comma else R.string.imports_mapping_sep_period)

@Composable
private fun thousandsLabel(value: String): String =
    stringResource(
        when (value) {
            "'" -> R.string.imports_mapping_sep_apostrophe
            "," -> R.string.imports_mapping_sep_comma
            "." -> R.string.imports_mapping_sep_period
            " " -> R.string.imports_mapping_sep_space
            else -> R.string.imports_mapping_sep_none
        },
    )

@Composable
private fun amountModeLabel(value: String): String =
    stringResource(
        when (value) {
            "single_with_indicator" -> R.string.imports_mapping_mode_indicator
            "split" -> R.string.imports_mapping_mode_split
            else -> R.string.imports_mapping_mode_single
        },
    )
