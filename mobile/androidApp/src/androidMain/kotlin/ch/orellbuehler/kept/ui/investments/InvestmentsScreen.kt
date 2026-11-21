package ch.orellbuehler.kept.ui.investments

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.QueryStats
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptException
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.InvestmentGroup
import ch.orellbuehler.kept.model.InvestmentPosition
import ch.orellbuehler.kept.model.InvestmentTotal
import ch.orellbuehler.kept.model.InvestmentsPage
import ch.orellbuehler.kept.model.PriceHistory
import ch.orellbuehler.kept.model.SecurityItem
import ch.orellbuehler.kept.model.SecurityLookupResult
import ch.orellbuehler.kept.model.SecurityMatch
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Which security's price history the page loads (`prices`), and whether all of it (`all=1`). */
data class PriceQuery(
    val securityId: String? = null,
    val all: Boolean = false,
) {
    fun params(): Map<String, String> =
        buildMap {
            if (securityId != null) {
                put("prices", securityId)
                if (all) put("all", "1")
            }
        }
}

sealed interface LookupState {
    data object Idle : LookupState

    data object Searching : LookupState

    data class Failed(
        val message: String,
    ) : LookupState

    data class Results(
        val matches: List<SecurityMatch>,
    ) : LookupState
}

class InvestmentsViewModel(
    sdk: KeptSdk,
    private val query: MutableStateFlow<PriceQuery> = MutableStateFlow(PriceQuery()),
) : PageViewModel<InvestmentsPage>(sdk, { it.load("investments", query.value.params()) }) {
    private val path = "investments"

    val priceQuery: StateFlow<PriceQuery> = query.asStateFlow()

    private val mutableLookup = MutableStateFlow<LookupState>(LookupState.Idle)
    val lookup: StateFlow<LookupState> = mutableLookup.asStateFlow()

    private val mutableSecuritySaved = MutableStateFlow(0)

    /** Counts saved security forms: a change closes the form sheet. */
    val securitySaved: StateFlow<Int> = mutableSecuritySaved.asStateFlow()

    private val mutablePriceSaved = MutableStateFlow(0)

    /** Counts saved prices: a change clears the price field. */
    val priceSaved: StateFlow<Int> = mutablePriceSaved.asStateFlow()

    fun showPrices(securityId: String?) {
        query.value = PriceQuery(securityId)
        clearFormErrors()
        if (securityId != null) refresh()
    }

    fun showAllPrices() {
        query.value = query.value.copy(all = true)
        refresh()
    }

    fun clearLookup() {
        mutableLookup.value = LookupState.Idle
    }

    fun search(text: String) {
        if (!canSearch(text) || mutableLookup.value == LookupState.Searching) return
        mutableLookup.value = LookupState.Searching
        viewModelScope.launch {
            mutableLookup.value =
                try {
                    val result = sdk.action(path, "lookup", FormBody().set("q", text.trim()))
                    if (result.ok) {
                        LookupState.Results(ApiJson.decodeFromString<SecurityLookupResult>(result.json).matches)
                    } else {
                        LookupState.Failed(result.message.orEmpty())
                    }
                } catch (e: KeptException) {
                    LookupState.Failed(e.message.orEmpty())
                } catch (e: kotlinx.serialization.SerializationException) {
                    LookupState.Failed(e.javaClass.simpleName)
                }
        }
    }

    fun save(
        id: String?,
        values: SecurityFormValues,
    ) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        if (id != null) form.set("securityId", id)
        submit(path, if (id == null) "createSecurity" else "updateSecurity", form) { mutableSecuritySaved.value++ }
    }

    fun delete(id: String) = submit(path, "deleteSecurity", FormBody().set("securityId", id), showRefusal = true)

    fun setPrice(
        securityId: String,
        date: String,
        price: String,
    ) {
        submit(
            path,
            "setPrice",
            FormBody().set("securityId", securityId).set("date", date).set("price", price),
        ) { mutablePriceSaved.value++ }
    }

    fun deletePrice(id: String) = submit(path, "deletePrice", FormBody().set("priceId", id), showRefusal = true)
}

/** The portfolio, its securities and their prices. */
@Composable
fun InvestmentsScreen(nav: Navigator) {
    val vm = keptViewModel { InvestmentsViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val lookup by vm.lookup.collectAsStateWithLifecycle()
    val priceQuery by vm.priceQuery.collectAsStateWithLifecycle()
    val securitySaved by vm.securitySaved.collectAsStateWithLifecycle()
    val priceSaved by vm.priceSaved.collectAsStateWithLifecycle()
    val page = (state as? Load.Ready)?.value

    var formOpen by rememberSaveable { mutableStateOf(false) }
    var editingId by rememberSaveable { mutableStateOf<String?>(null) }
    var formKey by rememberSaveable { mutableIntStateOf(0) }
    var deleting by remember { mutableStateOf<SecurityItem?>(null) }

    LaunchedEffect(securitySaved) { if (securitySaved > 0) formOpen = false }

    fun openForm(id: String?) {
        vm.clearFormErrors()
        vm.clearLookup()
        editingId = id
        formKey++
        formOpen = true
    }

    PageScaffold(
        title = stringResource(R.string.more_investments),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { if (it is UiEvent.Navigate) nav.openWebPath(it.webPath, replace = true) },
        floatingActionButton = {
            if (page != null) {
                FloatingActionButton(onClick = { openForm(null) }) {
                    Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.investments_add))
                }
            }
        },
    ) { data, padding ->
        if (data.securities.isEmpty()) {
            MessagePane(
                icon = Icons.Outlined.QueryStats,
                title = stringResource(R.string.investments_empty_title),
                text = stringResource(R.string.investments_empty_text),
                action = stringResource(R.string.investments_add),
                onAction = { openForm(null) },
            )
        } else {
            ScrollColumn(padding) {
                data.overview.totals.forEach { TotalCard(it) }
                PositionsCard(data, nav)
                SecuritiesCard(
                    data.securities,
                    onPrices = { vm.showPrices(it.id) },
                    onEdit = { openForm(it.id) },
                    onDelete = { deleting = it },
                )
            }
        }
    }

    if (page != null && formOpen) {
        val security = page.securities.firstOrNull { it.id == editingId }
        SecurityFormSheet(
            key = formKey,
            security = security,
            market = page.marketData,
            lookup = lookup,
            busy = busy,
            errors = errors,
            onDismiss = { formOpen = false },
            onSearch = vm::search,
            onSubmit = { vm.save(security?.id, it) },
            onMarketData = {
                formOpen = false
                nav.open(Routes.SETTINGS_MARKET_DATA)
            },
            onPicked = vm::clearLookup,
        )
    }
    if (priceQuery.securityId != null) {
        PriceHistorySheet(
            securityId = priceQuery.securityId.orEmpty(),
            history = page?.priceHistory?.takeIf { it.security.id == priceQuery.securityId },
            busy = busy,
            errors = errors,
            priceSaved = priceSaved,
            onDismiss = { vm.showPrices(null) },
            onSetPrice = vm::setPrice,
            onShowAll = vm::showAllPrices,
            onDeletePrice = vm::deletePrice,
        )
    }
    deleting?.let { security ->
        ConfirmDialog(
            title = stringResource(R.string.investments_delete_title, security.name),
            text = stringResource(R.string.investments_delete_text),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = { vm.delete(security.id) },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun TotalCard(total: InvestmentTotal) {
    SectionCard(
        title = stringResource(R.string.investments_holdings_in, total.currency),
        trailing = { if (total.estimated) Pill(stringResource(R.string.investments_estimated)) },
    ) {
        AmountText(total.value, total.currency, style = MaterialTheme.typography.headlineMedium)
        if (total.estimated) HintLine(stringResource(R.string.investments_estimated_hint))
        Spacer(Modifier.height(8.dp))
        LabelledAmount(stringResource(R.string.investments_cost), total.cost, total.currency, AmountTone.PLAIN)
        LabelledAmount(stringResource(R.string.investments_gain), total.gain, total.currency, AmountTone.SIGNED, showPlus = true)
    }
}

@Composable
private fun LabelledAmount(
    label: String,
    minor: Long,
    currency: String,
    tone: AmountTone,
    showPlus: Boolean = false,
) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        AmountText(minor, currency, tone = tone, showPlus = showPlus, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun HintLine(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun sourceLabel(source: String): String =
    stringResource(
        when (source) {
            "provider" -> R.string.investments_source_provider
            "trade" -> R.string.investments_source_trade
            else -> R.string.investments_source_manual
        },
    )

@Composable
private fun kindLabel(kind: String): String =
    stringResource(
        when (kind) {
            "etf" -> R.string.investments_kind_etf
            "stock" -> R.string.investments_kind_stock
            "fund" -> R.string.investments_kind_fund
            "bond" -> R.string.investments_kind_bond
            else -> R.string.investments_kind_other
        },
    )

@Composable
private fun PositionsCard(
    page: InvestmentsPage,
    nav: Navigator,
) {
    SectionCard(
        title = stringResource(R.string.investments_positions),
        subtitle = stringResource(R.string.investments_positions_hint),
        contentPadding = false,
    ) {
        if (page.overview.securities.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.investments_no_holdings_title), style = MaterialTheme.typography.titleSmall)
                HintLine(stringResource(R.string.investments_no_holdings_text))
                OutlinedButton(onClick = { nav.open(Routes.ACCOUNTS) }) { Text(stringResource(R.string.investments_go_to_accounts)) }
            }
        } else {
            page.overview.securities.forEachIndexed { index, group ->
                if (index > 0) RowDivider()
                GroupRow(group, nav)
            }
        }
    }
}

@Composable
private fun GroupRow(
    group: InvestmentGroup,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    Column {
        ListRow(
            title = group.name,
            subtitle =
                stringResource(
                    R.string.investments_quantity_price,
                    formatFixed(group.quantity, formats.locale),
                    formatFixed(group.price, formats.locale, 2),
                    group.currency,
                ) + "\n" +
                    stringResource(R.string.investments_price_meta, formats.date(group.priceDate), sourceLabel(group.priceSource)),
            trailing = {
                group.totals.forEach { total ->
                    AmountText(total.value, total.currency, style = MaterialTheme.typography.bodyLarge)
                    GainText(total.gain, total.currency, total.estimated)
                }
            },
        )
        if (group.positions.size > 1) {
            group.positions.forEach { position -> PositionRow(position, nav) }
        }
    }
}

@Composable
private fun GainText(
    gain: Long,
    currency: String,
    estimated: Boolean,
) {
    if (estimated) {
        Text("–", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    } else {
        AmountText(gain, currency, tone = AmountTone.SIGNED, showPlus = true, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun PositionRow(
    position: InvestmentPosition,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    ListRow(
        title = position.accountName,
        subtitle = listOfNotNull(position.institutionName, formatFixed(position.quantity, formats.locale)).joinToString(" · "),
        modifier = Modifier.padding(start = 16.dp),
        onClick = { nav.open(Routes.account(position.accountId)) },
        trailing = {
            AmountText(position.value, position.accountCurrency, style = MaterialTheme.typography.bodyMedium)
            GainText(position.gain, position.accountCurrency, position.estimated)
        },
    )
}

@Composable
private fun SecuritiesCard(
    securities: List<SecurityItem>,
    onPrices: (SecurityItem) -> Unit,
    onEdit: (SecurityItem) -> Unit,
    onDelete: (SecurityItem) -> Unit,
) {
    SectionCard(
        title = stringResource(R.string.investments_securities),
        subtitle = stringResource(R.string.investments_securities_hint),
        contentPadding = false,
    ) {
        securities.forEachIndexed { index, security ->
            if (index > 0) RowDivider()
            var menu by remember { mutableStateOf(false) }
            ListRow(
                title = security.name,
                subtitle = listOfNotNull(kindLabel(security.kind), security.symbol, security.currency, security.isin).joinToString(" · "),
                onClick = { onPrices(security) },
                trailing = {
                    Box {
                        IconButton(onClick = { menu = true }) {
                            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.investments_prices)) },
                                onClick = {
                                    menu = false
                                    onPrices(security)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.edit)) },
                                onClick = {
                                    menu = false
                                    onEdit(security)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                                onClick = {
                                    menu = false
                                    onDelete(security)
                                },
                            )
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun SecurityFormSheet(
    key: Int,
    security: SecurityItem?,
    market: ch.orellbuehler.kept.model.InvestmentsMarketData,
    lookup: LookupState,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSearch: (String) -> Unit,
    onSubmit: (SecurityFormValues) -> Unit,
    onMarketData: () -> Unit,
    onPicked: () -> Unit,
) {
    val defaultCurrency = LocalSession.current?.preferences?.defaultCurrency ?: "CHF"
    val initial = remember(key) { SecurityFormValues.of(security, defaultCurrency) }
    var name by rememberSaveable(key) { mutableStateOf(initial.name) }
    var kind by rememberSaveable(key) { mutableStateOf(initial.kind) }
    var isin by rememberSaveable(key) { mutableStateOf(initial.isin) }
    var symbol by rememberSaveable(key) { mutableStateOf(initial.symbol) }
    var currency by rememberSaveable(key) { mutableStateOf(initial.currency) }
    var query by rememberSaveable(key) { mutableStateOf("") }
    val kinds = securityKinds.map { Choice(it, kindLabel(it)) }
    FormSheet(
        title = stringResource(if (security == null) R.string.investments_add else R.string.investments_edit),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(SecurityFormValues(name, kind, isin, symbol, currency)) },
        busy = busy,
        error = errors["form"] ?: errors["securityId"],
        submitLabel = stringResource(if (security == null) R.string.investments_add else R.string.save),
    ) {
        HintLine(stringResource(R.string.investments_form_hint))
        if (market.canLookup) {
            LookupSection(
                query = query,
                onQuery = { query = it },
                lookup = lookup,
                onSearch = { onSearch(query) },
                onPick = { match ->
                    val values = SecurityFormValues(name, kind, isin, symbol, currency).withMatch(match)
                    name = values.name
                    kind = values.kind
                    isin = values.isin
                    symbol = values.symbol
                    currency = values.currency
                    onPicked()
                },
            )
        } else if (market.enabled) {
            HintLine(stringResource(R.string.investments_lookup_unavailable))
        } else {
            TextButton(onClick = onMarketData) { Text(stringResource(R.string.investments_lookup_turn_on)) }
        }
        FormTextField(
            stringResource(R.string.investments_name),
            name,
            { name = it },
            error = errors["name"],
            capitalization = KeyboardCapitalization.Words,
        )
        ChoiceField(stringResource(R.string.investments_type), kinds, kind, { kind = it }, error = errors["kind"])
        FormTextField(
            stringResource(R.string.investments_currency),
            currency,
            { currency = it.take(3).uppercase() },
            error = errors["currency"],
            hint = stringResource(R.string.investments_currency_hint),
            capitalization = KeyboardCapitalization.Characters,
        )
        FormTextField(
            stringResource(R.string.investments_isin),
            isin,
            { isin = it.take(12).uppercase() },
            error = errors["isin"],
            capitalization = KeyboardCapitalization.Characters,
        )
        FormTextField(
            stringResource(R.string.investments_symbol),
            symbol,
            { symbol = it.take(24).uppercase() },
            error = errors["symbol"],
            hint = stringResource(R.string.investments_symbol_hint),
            capitalization = KeyboardCapitalization.Characters,
        )
    }
}

@Composable
private fun LookupSection(
    query: String,
    onQuery: (String) -> Unit,
    lookup: LookupState,
    onSearch: () -> Unit,
    onPick: (SecurityMatch) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            FormTextField(
                stringResource(R.string.investments_lookup_label),
                query,
                { onQuery(it.take(100)) },
                modifier = Modifier.weight(1f),
                placeholder = stringResource(R.string.investments_lookup_placeholder),
            )
            Button(
                onClick = onSearch,
                enabled = canSearch(query) && lookup != LookupState.Searching,
                modifier = Modifier.padding(top = 8.dp).height(48.dp),
            ) {
                if (lookup == LookupState.Searching) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Outlined.Search, contentDescription = stringResource(R.string.investments_lookup_search))
                }
            }
        }
        HintLine(stringResource(R.string.investments_lookup_privacy))
        when (lookup) {
            is LookupState.Failed ->
                Text(
                    lookup.message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            is LookupState.Results ->
                if (lookup.matches.isEmpty()) {
                    HintLine(stringResource(R.string.investments_lookup_none))
                } else {
                    lookup.matches.forEach { match ->
                        ListRow(
                            title = match.name,
                            subtitle = listOfNotNull(match.symbol, match.isin, match.currency).joinToString(" · "),
                            onClick = { onPick(match) },
                        )
                    }
                }
            else -> Unit
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PriceHistorySheet(
    securityId: String,
    history: PriceHistory?,
    busy: Boolean,
    errors: Map<String, String>,
    priceSaved: Int,
    onDismiss: () -> Unit,
    onSetPrice: (String, String, String) -> Unit,
    onShowAll: () -> Unit,
    onDeletePrice: (String) -> Unit,
) {
    val formats = LocalFormats.current
    val today =
        LocalSession.current?.today?.takeIf { it.isNotBlank() } ?: java.time.LocalDate
            .now()
            .toString()
    var date by rememberSaveable(securityId) { mutableStateOf(today) }
    var price by rememberSaveable(securityId) { mutableStateOf("") }
    var deleting by remember { mutableStateOf<ch.orellbuehler.kept.model.PricePoint?>(null) }
    LaunchedEffect(priceSaved) { if (priceSaved > 0) price = "" }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        if (history == null) {
            Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@ModalBottomSheet
        }
        androidx.compose.foundation.lazy.LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            contentPadding =
                androidx.compose.foundation.layout
                    .PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Text(history.security.name, style = MaterialTheme.typography.titleLarge)
                HintLine(stringResource(R.string.investments_history_title, history.security.currency))
                HintLine(stringResource(R.string.investments_history_hint))
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    DateField(stringResource(R.string.investments_price_date), date, { date = it }, error = errors["date"])
                    AmountField(
                        stringResource(R.string.investments_price_label, history.security.currency),
                        price,
                        { price = it },
                        error = errors["price"],
                    )
                    val formError = errors["form"] ?: errors["securityId"]
                    if (formError != null) Text(formError, color = MaterialTheme.colorScheme.error)
                    Button(onClick = { onSetPrice(history.security.id, date, price) }, enabled = !busy) {
                        Text(stringResource(R.string.investments_set_price))
                    }
                }
            }
            if (history.prices.isEmpty()) {
                item {
                    Text(stringResource(R.string.investments_no_prices_title), style = MaterialTheme.typography.titleSmall)
                    HintLine(
                        stringResource(
                            if (history.security.symbol !=
                                null
                            ) {
                                R.string.investments_no_prices_text_symbol
                            } else {
                                R.string.investments_no_prices_text
                            },
                        ),
                    )
                }
            } else {
                items(history.prices.size) { index ->
                    val point = history.prices[index]
                    ListRow(
                        title = formatFixed(point.price, formats.locale, 2) + " " + history.security.currency,
                        subtitle = formats.date(point.date),
                        trailing = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Pill(sourceLabel(point.source))
                                if (point.source == "manual") {
                                    IconButton(onClick = { deleting = point }) {
                                        Icon(
                                            Icons.Outlined.Delete,
                                            contentDescription =
                                                stringResource(
                                                    R.string.investments_delete_price,
                                                    formats.date(point.date),
                                                ),
                                        )
                                    }
                                }
                            }
                        },
                    )
                }
                if (history.total > history.prices.size) {
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                stringResource(R.string.investments_showing, history.prices.size, history.total),
                                Modifier.weight(1f),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            TextButton(onClick = onShowAll) { Text(stringResource(R.string.investments_show_all)) }
                        }
                    }
                }
            }
        }
    }
    deleting?.let { point ->
        ConfirmDialog(
            title = stringResource(R.string.investments_delete_price_title),
            text = stringResource(R.string.investments_delete_price_text, formats.date(point.date)),
            confirmLabel = stringResource(R.string.delete),
            onConfirm = { onDeletePrice(point.id) },
            onDismiss = { deleting = null },
        )
    }
}
