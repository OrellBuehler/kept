package ch.orellbuehler.kept.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.Dashboard
import ch.orellbuehler.kept.model.DashboardAccount
import ch.orellbuehler.kept.model.DashboardBills
import ch.orellbuehler.kept.model.DashboardPage
import ch.orellbuehler.kept.model.MonthSummary
import ch.orellbuehler.kept.model.Spending
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.AmountText
import ch.orellbuehler.kept.ui.components.AmountTone
import ch.orellbuehler.kept.ui.components.IconBadge
import ch.orellbuehler.kept.ui.components.LineChart
import ch.orellbuehler.kept.ui.components.ListRow
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
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private val ranges =
    listOf(
        "3m" to R.string.dashboard_range_3m,
        "6m" to R.string.dashboard_range_6m,
        "12m" to R.string.dashboard_range_12m,
        "all" to R.string.dashboard_range_all,
    )

class DashboardViewModel(
    sdk: KeptSdk,
    private val range: MutableStateFlow<String> = MutableStateFlow("12m"),
) : PageViewModel<DashboardPage>(sdk, { it.load("dashboard", mapOf("range" to range.value)) }) {
    val selectedRange: StateFlow<String> = range.asStateFlow()

    fun selectRange(value: String) {
        if (range.value == value) return
        range.value = value
        refresh()
    }
}

/** The overview: net worth, this month, what is due, where the money went, and every account. */
@Composable
fun DashboardScreen(nav: Navigator) {
    val vm = keptViewModel { DashboardViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val range by vm.selectedRange.collectAsStateWithLifecycle()
    PageScaffold(
        title = stringResource(R.string.nav_overview),
        state = state,
        onRefresh = vm::refresh,
        events = vm.events,
    ) { page, padding ->
        val dashboard = page.dashboard
        ScrollColumn(padding) {
            Alerts(page, nav)
            NetWorthCard(dashboard, range, vm::selectRange)
            MonthCard(dashboard.shareMonth ?: dashboard.month)
            BillsCard(dashboard.bills, nav)
            SpendingCard(dashboard.spending)
            AccountsCard(dashboard.accounts, nav)
        }
    }
}

@Composable
private fun Alerts(
    page: DashboardPage,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    val dashboard = page.dashboard
    val rows =
        buildList<Triple<String, String?, () -> Unit>> {
            page.forecastAlerts.forEach { alert ->
                add(
                    Triple(
                        stringResource(R.string.dashboard_alert_negative, alert.name),
                        stringResource(R.string.dashboard_alert_negative_text, formats.date(alert.date)),
                    ) { nav.open(Routes.FORECAST) },
                )
            }
            page.needsAmount.forEach { transfer ->
                add(
                    Triple(
                        stringResource(R.string.dashboard_alert_needs_amount, transfer.targetAccountName),
                        formats.date(transfer.bookingDate),
                    ) { nav.open(Routes.account(transfer.sourceAccountId)) },
                )
            }
            if (dashboard.unmatched.count > 0) {
                add(
                    Triple(
                        pluralStringResource(R.plurals.dashboard_alert_unmatched, dashboard.unmatched.count, dashboard.unmatched.count),
                        null,
                    ) { nav.open(Routes.BILLS) },
                )
            }
            if (dashboard.staleAccounts > 0) {
                add(
                    Triple(
                        pluralStringResource(R.plurals.dashboard_alert_stale, dashboard.staleAccounts, dashboard.staleAccounts),
                        null,
                    ) { nav.open(Routes.IMPORT) },
                )
            }
        }
    if (rows.isEmpty()) return
    SectionCard(contentPadding = false) {
        rows.forEachIndexed { index, (title, subtitle, onClick) ->
            if (index > 0) RowDivider()
            ListRow(
                title = title,
                subtitle = subtitle,
                leading = { IconBadge(Icons.Outlined.WarningAmber, tint = MaterialTheme.kept.warning) },
                onClick = onClick,
                showChevron = true,
            )
        }
    }
}

@Composable
private fun NetWorthCard(
    dashboard: Dashboard,
    range: String,
    onRange: (String) -> Unit,
) {
    val netWorth = dashboard.netWorth
    val series = netWorth.shareSeries ?: netWorth.series
    SectionCard(
        title = stringResource(R.string.dashboard_net_worth),
        subtitle = if (dashboard.hasShared) stringResource(R.string.dashboard_share_hint) else null,
    ) {
        if (netWorth.totals.isEmpty()) {
            Text(stringResource(R.string.dashboard_no_accounts), color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@SectionCard
        }
        netWorth.totals.forEach { total ->
            AmountText(
                total.shareBalance,
                total.currency,
                tone = AmountTone.NEGATIVE,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
            )
            val points = series.firstOrNull { it.currency == total.currency }?.points.orEmpty()
            if (points.size >= 2) {
                Spacer(Modifier.height(8.dp))
                LineChart(points.map { it.amount })
                Spacer(Modifier.height(8.dp))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ranges.forEach { (value, label) ->
                FilterChip(selected = range == value, onClick = { onRange(value) }, label = { Text(stringResource(label), maxLines = 1) })
            }
        }
    }
}

@Composable
private fun MonthCard(month: MonthSummary) {
    val formats = LocalFormats.current
    SectionCard(title = formats.month(month.month)) {
        if (month.totals.isEmpty()) {
            Text(stringResource(R.string.dashboard_no_transactions), color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@SectionCard
        }
        month.totals.forEachIndexed { index, total ->
            if (index > 0) Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Figure(stringResource(R.string.dashboard_income), total.income, total.currency, AmountTone.PLAIN, Modifier.weight(1f))
                Figure(stringResource(R.string.dashboard_expenses), total.expenses, total.currency, AmountTone.PLAIN, Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            Figure(
                stringResource(R.string.dashboard_net),
                total.net,
                total.currency,
                AmountTone.SIGNED,
                Modifier.fillMaxWidth(),
                showPlus = true,
            )
            month.previousTotals.firstOrNull { it.currency == total.currency }?.let { previous ->
                Text(
                    stringResource(
                        R.string.dashboard_previous_net,
                        formats.month(month.previousMonth),
                        formats.signedMoney(previous.net, previous.currency),
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun Figure(
    label: String,
    minor: Long,
    currency: String,
    tone: AmountTone,
    modifier: Modifier = Modifier,
    showPlus: Boolean = false,
) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        AmountText(minor, currency, tone = tone, showPlus = showPlus, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun BillsCard(
    bills: DashboardBills,
    nav: Navigator,
) {
    val formats = LocalFormats.current
    SectionCard(title = stringResource(R.string.nav_bills), onClick = { nav.open(Routes.BILLS) }, contentPadding = false) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Count(stringResource(R.string.dashboard_bills_overdue), bills.overdue.count, bills.overdue.count > 0, Modifier.weight(1f))
            Count(stringResource(R.string.dashboard_bills_due_soon), bills.dueSoon.count, false, Modifier.weight(1f))
            Count(stringResource(R.string.dashboard_bills_refund), bills.awaitingRefund.count, false, Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        bills.upcoming.forEach { bill ->
            RowDivider()
            ListRow(
                title = bill.creditorName ?: bill.invoiceNumber ?: stringResource(R.string.dashboard_bill_unnamed),
                subtitle = bill.dueDate?.let { stringResource(R.string.dashboard_bill_due, formats.date(it)) },
                onClick = { nav.open(Routes.bill(bill.id)) },
            ) {
                val amount = bill.remaining ?: bill.amount
                if (amount != null) AmountText(amount, bill.currency)
            }
        }
    }
}

@Composable
private fun Count(
    label: String,
    count: Int,
    alarming: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        Text(
            count.toString(),
            style = MaterialTheme.typography.headlineSmall,
            color = if (alarming) MaterialTheme.kept.negative else MaterialTheme.colorScheme.onSurface,
        )
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

@Composable
private fun SpendingCard(spending: Spending) {
    val charts = MaterialTheme.kept.charts
    if (spending.currencies.all { it.items.isEmpty() }) return
    SectionCard(title = stringResource(R.string.dashboard_spending), subtitle = LocalFormats.current.month(spending.month)) {
        spending.currencies.forEach { currency ->
            val largest = currency.items.maxOfOrNull { it.spent }?.takeIf { it > 0 } ?: 1L
            currency.items.forEachIndexed { index, item ->
                val color = parseColor(item.color, charts[index % charts.size])
                Row(Modifier.fillMaxWidth().padding(top = if (index > 0) 12.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(10.dp).clip(CircleShape).background(color))
                    Text(
                        item.name.ifBlank { stringResource(R.string.dashboard_uncategorized) },
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                    )
                    AmountText(item.spent, currency.currency, style = MaterialTheme.typography.bodyMedium)
                }
                ProgressBar(item.spent.toFloat() / largest, Modifier.padding(top = 6.dp), color = color)
            }
        }
    }
}

@Composable
private fun AccountsCard(
    accounts: List<DashboardAccount>,
    nav: Navigator,
) {
    if (accounts.isEmpty()) return
    SectionCard(title = stringResource(R.string.nav_accounts), contentPadding = false) {
        accounts.forEachIndexed { index, account ->
            if (index > 0) RowDivider()
            ListRow(
                title = account.name,
                subtitle = account.institution?.name,
                leading = {
                    IconBadge(
                        Icons.Outlined.AccountBalance,
                        tint = parseColor(account.institution?.color, MaterialTheme.colorScheme.primary),
                    )
                },
                onClick = { nav.open(Routes.account(account.id)) },
            ) {
                AmountText(account.balance, account.currency, tone = AmountTone.NEGATIVE)
                if (account.stale) {
                    Icon(
                        Icons.Outlined.WarningAmber,
                        contentDescription = stringResource(R.string.dashboard_stale),
                        tint = MaterialTheme.kept.warning,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }
}
