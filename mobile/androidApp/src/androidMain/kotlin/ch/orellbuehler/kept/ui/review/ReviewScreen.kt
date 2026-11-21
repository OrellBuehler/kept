package ch.orellbuehler.kept.ui.review

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ReviewChange
import ch.orellbuehler.kept.model.ReviewCurrency
import ch.orellbuehler.kept.model.ReviewFlowNode
import ch.orellbuehler.kept.model.ReviewPage
import ch.orellbuehler.kept.model.ReviewTransaction
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.ListRow
import ch.orellbuehler.kept.ui.components.MessagePane
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ProgressBar
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.parseColor
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.nav.Routes
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow

class ReviewViewModel(
    sdk: KeptSdk,
    private val year: MutableStateFlow<Int?> = MutableStateFlow(null),
) : PageViewModel<ReviewPage>(sdk, { it.load("review", year.value?.let { value -> mapOf("year" to value.toString()) } ?: emptyMap()) }) {
    fun goTo(value: Int) {
        if (year.value == value) return
        year.value = value
        refresh()
    }
}

/** The year in numbers: income, expenses, savings, where the money went, and the biggest items. */
@Composable
fun ReviewScreen(nav: Navigator) {
    val vm = keptViewModel { ReviewViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    PageScaffold(
        title = stringResource(R.string.review_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { if (it is UiEvent.Navigate) nav.openWebPath(it.webPath, replace = true) },
    ) { page, padding ->
        ScrollColumn(padding) {
            YearBar(page, vm::goTo)
            val review = page.review
            Text(
                if (review.partial) {
                    stringResource(R.string.review_partial, page.year, LocalFormats.current.date(review.to))
                } else {
                    stringResource(R.string.review_full, page.year)
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                stringResource(R.string.review_note) +
                    if (review.excludedTransfers > 0) {
                        " " + pluralStringResource(R.plurals.review_excluded, review.excludedTransfers, review.excludedTransfers, page.year)
                    } else {
                        ""
                    },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (review.currencies.isEmpty()) {
                MessagePane(
                    icon = Icons.Outlined.CalendarMonth,
                    title = stringResource(R.string.review_empty_title, page.year),
                    text = stringResource(R.string.review_empty_text),
                    action = stringResource(R.string.review_import),
                    onAction = { nav.open(Routes.IMPORT) },
                )
            }
            review.currencies.forEach { CurrencySection(it, page.year) }
        }
    }
}

@Composable
private fun YearBar(
    page: ReviewPage,
    onYear: (Int) -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { onYear(page.year - 1) }, enabled = canStep(page.year, -1, page.firstYear, page.currentYear)) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = stringResource(R.string.review_previous_year))
        }
        Text(
            page.year.toString(),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.Center,
        )
        IconButton(onClick = { onYear(page.year + 1) }, enabled = canStep(page.year, 1, page.firstYear, page.currentYear)) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.review_next_year))
        }
    }
}

@Composable
private fun CurrencySection(
    c: ReviewCurrency,
    year: Int,
) {
    val formats = LocalFormats.current
    SectionCard(title = c.currency) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Figure(stringResource(R.string.review_income), Modifier.weight(1f)) { AmountText(c.income, c.currency, style = it) }
            Figure(stringResource(R.string.review_expenses), Modifier.weight(1f)) { AmountText(c.expenses, c.currency, style = it) }
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Figure(stringResource(R.string.review_net), Modifier.weight(1f)) {
                AmountText(c.net, c.currency, tone = AmountTone.SIGNED, style = it)
            }
            Figure(stringResource(R.string.review_savings_rate), Modifier.weight(1f)) {
                val rate = c.savingsRate
                Text(
                    rate?.let { value -> formats.percent(value, 0) } ?: stringResource(R.string.review_not_available),
                    style = it,
                    color = if (rate != null && rate < 0) MaterialTheme.kept.negative else Color.Unspecified,
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp)) {
            Figure(stringResource(R.string.review_net_worth), Modifier.weight(1f)) {
                val netWorth = c.netWorth
                if (netWorth == null) {
                    Text(stringResource(R.string.review_not_available), style = it)
                } else {
                    AmountText(netWorth.change, c.currency, tone = AmountTone.SIGNED, showPlus = true, style = it)
                }
            }
        }
    }
    FlowCard(c)
    SectionCard(title = stringResource(R.string.review_months_title)) { MonthChart(c) }
    ChangesCard(c, year)
    CounterpartiesCard(c)
    TransactionsCard(stringResource(R.string.review_largest_expenses), c.largestExpenses, c.currency)
    TransactionsCard(stringResource(R.string.review_largest_income), c.largestIncome, c.currency)
}

@Composable
private fun Figure(
    label: String,
    modifier: Modifier = Modifier,
    value: @Composable (androidx.compose.ui.text.TextStyle) -> Unit,
) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        value(MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun FlowCard(c: ReviewCurrency) {
    val incomeTotal = c.sankey.left.sumOf { it.value }
    if (incomeTotal <= 0 && c.sankey.right.isEmpty()) return
    SectionCard(title = stringResource(R.string.review_flow_title), subtitle = stringResource(R.string.review_flow_text)) {
        FlowGroup(stringResource(R.string.review_flow_income), c.sankey.left, incomeTotal, c.currency)
        Box(Modifier.height(8.dp))
        FlowGroup(stringResource(R.string.review_flow_spent), c.sankey.right, incomeTotal, c.currency)
    }
}

@Composable
private fun FlowGroup(
    title: String,
    nodes: List<ReviewFlowNode>,
    total: Long,
    currency: String,
) {
    if (nodes.isEmpty()) return
    val charts = MaterialTheme.kept.charts
    Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    nodes.forEachIndexed { index, node ->
        val color =
            when (node.kind) {
                "saved" -> MaterialTheme.kept.positive
                else -> parseColor(node.color, charts[index % charts.size])
            }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(color))
            Text(
                node.label,
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                maxLines = 1,
                style = MaterialTheme.typography.bodyMedium,
            )
            AmountText(node.value, currency, style = MaterialTheme.typography.bodyMedium)
        }
        ProgressBar(share(node.value, total), Modifier.padding(top = 4.dp), color = color)
    }
}

@Composable
private fun MonthChart(c: ReviewCurrency) {
    val formats = LocalFormats.current
    val income = MaterialTheme.kept.charts[0]
    val expenses = MaterialTheme.kept.charts[4 % MaterialTheme.kept.charts.size]
    val bars = remember(c.months) { monthBars(c.months) }
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Legend(income, stringResource(R.string.review_income))
        Legend(expenses, stringResource(R.string.review_expenses))
    }
    Canvas(Modifier.fillMaxWidth().height(128.dp).padding(top = 8.dp)) {
        if (bars.isEmpty()) return@Canvas
        val slot = size.width / bars.size
        val barWidth = (slot / 2f - 2.dp.toPx()).coerceAtLeast(1f)
        val radius = CornerRadius(2.dp.toPx())
        bars.forEachIndexed { index, bar ->
            val left = slot * index + (slot - 2 * barWidth - 2.dp.toPx()) / 2f
            listOf(bar.income to income, bar.expenses to expenses).forEachIndexed { side, (fraction, color) ->
                val barHeight = size.height * fraction
                drawRoundRect(
                    color = color,
                    topLeft = Offset(left + side * (barWidth + 2.dp.toPx()), size.height - barHeight),
                    size = Size(barWidth, barHeight),
                    cornerRadius = radius,
                )
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        c.months.forEach {
            Text(
                monthInitial(it.month, formats.locale),
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun Legend(
    color: Color,
    label: String,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Text(label, modifier = Modifier.padding(start = 6.dp), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ChangesCard(
    c: ReviewCurrency,
    year: Int,
) {
    val formats = LocalFormats.current
    SectionCard(
        title = stringResource(R.string.review_changes_title),
        subtitle = stringResource(R.string.review_changes_text, year - 1),
        contentPadding = c.hasPreviousYear.not(),
    ) {
        if (!c.hasPreviousYear) {
            Text(
                stringResource(R.string.review_changes_none, c.currency, year - 1),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            return@SectionCard
        }
        c.changes.forEachIndexed { index, change ->
            if (index > 0) RowDivider()
            ListRow(title = change.name, subtitle = changeLine(change, formats.percent(change.changePct ?: 0.0, 0))) {
                AmountText(change.change, c.currency)
            }
        }
    }
}

@Composable
private fun changeLine(
    change: ReviewChange,
    percent: String,
): String {
    val side = stringResource(if (change.side == "income") R.string.review_change_income else R.string.review_change_expense)
    val detail =
        if (change.changePct == null) {
            stringResource(R.string.review_change_new)
        } else {
            (if (change.change > 0) "+" else "") + percent
        }
    return stringResource(R.string.review_change_line, side, detail)
}

@Composable
private fun CounterpartiesCard(c: ReviewCurrency) {
    SectionCard(title = stringResource(R.string.review_counterparties_title), contentPadding = c.counterparties.isEmpty()) {
        if (c.counterparties.isEmpty()) {
            Text(
                stringResource(R.string.review_counterparties_none),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            return@SectionCard
        }
        c.counterparties.forEachIndexed { index, party ->
            if (index > 0) RowDivider()
            ListRow(title = party.name, subtitle = pluralStringResource(R.plurals.review_payments, party.count, party.count)) {
                AmountText(party.spent, c.currency)
            }
        }
    }
}

@Composable
private fun TransactionsCard(
    title: String,
    list: List<ReviewTransaction>,
    currency: String,
) {
    val formats = LocalFormats.current
    SectionCard(title = title, contentPadding = list.isEmpty()) {
        if (list.isEmpty()) {
            Text(
                stringResource(R.string.review_none),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            return@SectionCard
        }
        list.forEachIndexed { index, item ->
            if (index > 0) RowDivider()
            ListRow(
                title = item.counterparty ?: stringResource(R.string.review_no_counterparty),
                subtitle = formats.date(item.bookingDate) + (item.categoryName?.let { " · $it" } ?: ""),
            ) { AmountText(item.amount, currency, tone = AmountTone.SIGNED) }
        }
    }
}
