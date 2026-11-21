package ch.orellbuehler.kept.ui.accounts

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountsAccount
import ch.orellbuehler.kept.model.AccountsInstitution
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.SwitchRow
import ch.orellbuehler.kept.ui.components.parseColor

@StringRes
fun accountTypeLabel(type: String): Int =
    when (type) {
        "current" -> R.string.accounts_type_current
        "savings" -> R.string.accounts_type_savings
        "credit_card" -> R.string.accounts_type_credit_card
        "investment" -> R.string.accounts_type_investment
        "pension" -> R.string.accounts_type_pension
        "pillar_3a" -> R.string.accounts_type_pillar_3a
        "cash" -> R.string.accounts_type_cash
        else -> R.string.accounts_type_other
    }

/**
 * The account form of the web (`AccountFormDialog`): create when [account] is null, edit otherwise.
 * [onSubmit] gets the form, ready to send.
 */
@Composable
fun AccountFormSheet(
    account: AccountsAccount?,
    institutions: List<Pair<String, String>>,
    defaultInstitutionId: String,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (AccountDraft, hasPortfolios: Boolean, hasTrades: Boolean, confirmRemoveMirrors: Boolean) -> Unit,
    modifier: Modifier = Modifier,
    currencyLocked: Boolean = false,
    mirrorCount: Int? = null,
    hasPortfolios: Boolean = false,
    hasTrades: Boolean = false,
) {
    val defaultCurrency = LocalSession.current?.preferences?.defaultCurrency ?: "CHF"
    var draft by remember { mutableStateOf(AccountDraft.from(account, defaultInstitutionId, defaultCurrency)) }
    var confirmOff by remember { mutableStateOf(false) }
    val editing = account != null
    val turningOff = AccountDraft.needsMirrorConfirmation(account, draft, hasPortfolios, mirrorCount)

    FormSheet(
        title = stringResource(if (editing) R.string.accounts_edit_account else R.string.accounts_add_account),
        onDismiss = onDismiss,
        onSubmit = {
            if (turningOff) confirmOff = true else onSubmit(draft, hasPortfolios, hasTrades, false)
        },
        busy = busy,
        modifier = modifier,
        error = errors["form"],
        submitLabel = stringResource(if (editing) R.string.save else R.string.accounts_add_account),
        submitEnabled = draft.name.isNotBlank(),
    ) {
        FormTextField(
            label = stringResource(R.string.accounts_field_name),
            value = draft.name,
            onValueChange = { draft = draft.copy(name = it) },
            error = errors["name"],
            placeholder = stringResource(R.string.accounts_field_name_placeholder),
            capitalization = KeyboardCapitalization.Sentences,
        )
        ChoiceField(
            label = stringResource(R.string.accounts_field_institution),
            options = listOf(Choice("", stringResource(R.string.none))) + institutions.map { Choice(it.first, it.second) },
            selected = draft.institutionId,
            onSelect = { draft = draft.copy(institutionId = it) },
            error = errors["institutionId"],
        )
        ChoiceField(
            label = stringResource(R.string.accounts_field_type),
            options = ACCOUNT_TYPES.map { Choice(it, stringResource(accountTypeLabel(it))) },
            selected = draft.type,
            onSelect = { draft = draft.copy(type = it) },
            error = errors["type"],
        )
        FormTextField(
            label = stringResource(R.string.accounts_field_currency),
            value = draft.currency,
            onValueChange = { draft = draft.copy(currency = it.uppercase().take(3)) },
            error = errors["currency"],
            hint =
                stringResource(
                    when {
                        currencyLocked -> R.string.accounts_field_currency_locked
                        draft.is3a -> R.string.accounts_field_currency_3a
                        else -> R.string.accounts_field_currency_hint
                    },
                ),
            enabled = !currencyLocked,
            capitalization = KeyboardCapitalization.Characters,
        )
        FormTextField(
            label = stringResource(R.string.accounts_field_iban),
            value = draft.iban,
            onValueChange = { draft = draft.copy(iban = it) },
            error = errors["iban"],
            placeholder = stringResource(R.string.accounts_field_iban_placeholder),
            capitalization = KeyboardCapitalization.Characters,
        )
        if (draft.is3a) {
            FormTextField(
                label = stringResource(R.string.accounts_field_contract),
                value = draft.contractNumber,
                onValueChange = { draft = draft.copy(contractNumber = it) },
                error = errors["contractNumber"],
            )
            FormTextField(
                label = stringResource(R.string.accounts_field_deposit_iban),
                value = draft.depositIban,
                onValueChange = { draft = draft.copy(depositIban = it) },
                error = errors["depositIban"],
                hint = stringResource(R.string.accounts_field_deposit_iban_hint),
                capitalization = KeyboardCapitalization.Characters,
            )
        }
        AmountField(
            label = stringResource(R.string.accounts_field_opening_balance),
            value = draft.openingBalance,
            onValueChange = { draft = draft.copy(openingBalance = it) },
            error = errors["openingBalance"],
            hint = stringResource(R.string.accounts_field_opening_balance_hint),
            currency = draft.currency.ifBlank { null },
        )
        DateField(
            label = stringResource(R.string.accounts_field_opening_date),
            value = draft.openingDate,
            onValueChange = { draft = draft.copy(openingDate = it) },
            error = errors["openingDate"],
            optional = true,
        )
        if (!draft.is3a) {
            FormTextField(
                label = stringResource(R.string.accounts_field_share),
                value = draft.share,
                onValueChange = { draft = draft.copy(share = it) },
                error = errors["share"],
                hint = stringResource(R.string.accounts_field_share_hint),
                keyboardType = KeyboardType.Decimal,
            )
            FormTextField(
                label = stringResource(R.string.accounts_field_shared_with),
                value = draft.sharedWith,
                onValueChange = { draft = draft.copy(sharedWith = it) },
                error = errors["sharedWith"],
                hint = stringResource(R.string.accounts_field_shared_with_hint),
                capitalization = KeyboardCapitalization.Words,
            )
        }
        if (draft.hasNotice) {
            Text(stringResource(R.string.accounts_withdrawal), style = MaterialTheme.typography.titleSmall)
            FormTextField(
                label = stringResource(R.string.accounts_field_notice),
                value = draft.noticeMonths,
                onValueChange = { draft = draft.copy(noticeMonths = it.filter(Char::isDigit).take(2)) },
                error = errors["noticeMonths"],
                hint = stringResource(R.string.accounts_field_notice_hint),
                keyboardType = KeyboardType.Number,
            )
            AmountField(
                label = stringResource(R.string.accounts_field_free_withdrawal),
                value = draft.freeWithdrawal,
                onValueChange = { draft = draft.copy(freeWithdrawal = it) },
                error = errors["freeWithdrawal"],
                hint = stringResource(R.string.accounts_field_free_withdrawal_hint),
                currency = draft.currency.ifBlank { null },
            )
            ChoiceField(
                label = stringResource(R.string.accounts_field_free_period),
                options =
                    listOf(
                        Choice("", stringResource(R.string.none)),
                        Choice("month", stringResource(R.string.accounts_period_month)),
                        Choice("year", stringResource(R.string.accounts_period_year)),
                    ),
                selected = draft.freeWithdrawalPeriod,
                onSelect = { draft = draft.copy(freeWithdrawalPeriod = it) },
                error = errors["freeWithdrawalPeriod"],
            )
        }
        if (draft.showFill(hasPortfolios) || draft.showTradesCash(hasTrades)) {
            Text(stringResource(R.string.accounts_statements), style = MaterialTheme.typography.titleSmall)
        }
        if (draft.showFill(hasPortfolios)) {
            SwitchRow(
                title = stringResource(R.string.accounts_fill_from_transfers),
                subtitle = errors["fillFromTransfers"] ?: stringResource(R.string.accounts_fill_from_transfers_text),
                checked = draft.fillFromTransfers,
                onCheckedChange = { draft = draft.copy(fillFromTransfers = it) },
            )
        }
        if (draft.showTradesCash(hasTrades)) {
            SwitchRow(
                title = stringResource(R.string.accounts_trades_move_cash),
                subtitle = errors["tradesMoveCash"] ?: stringResource(R.string.accounts_trades_move_cash_text),
                checked = draft.tradesMoveCash,
                onCheckedChange = { draft = draft.copy(tradesMoveCash = it) },
            )
        }
    }
    if (confirmOff) {
        ConfirmDialog(
            title = stringResource(R.string.accounts_stop_filling),
            text =
                if (mirrorCount == null) {
                    stringResource(R.string.accounts_stop_filling_text_unknown)
                } else {
                    pluralStringResource(R.plurals.accounts_stop_filling_text, mirrorCount, mirrorCount)
                },
            confirmLabel = stringResource(R.string.accounts_stop_filling_confirm),
            onConfirm = { onSubmit(draft, hasPortfolios, hasTrades, true) },
            onDismiss = { confirmOff = false },
        )
    }
}

/** The institution form: name, BIC and colour. The logo is uploaded in the browser. */
@Composable
fun InstitutionFormSheet(
    institution: AccountsInstitution?,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (InstitutionDraft) -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember { mutableStateOf(InstitutionDraft.from(institution)) }
    FormSheet(
        title = stringResource(if (institution == null) R.string.accounts_add_institution else R.string.accounts_edit_institution),
        onDismiss = onDismiss,
        onSubmit = { onSubmit(draft) },
        busy = busy,
        modifier = modifier,
        error = errors["form"] ?: errors["logo"],
        submitLabel = stringResource(if (institution == null) R.string.accounts_add_institution else R.string.save),
        submitEnabled = draft.name.isNotBlank(),
    ) {
        FormTextField(
            label = stringResource(R.string.accounts_field_name),
            value = draft.name,
            onValueChange = { draft = draft.copy(name = it) },
            error = errors["name"],
            placeholder = stringResource(R.string.accounts_institution_placeholder),
            capitalization = KeyboardCapitalization.Words,
        )
        FormTextField(
            label = stringResource(R.string.accounts_field_bic),
            value = draft.bic,
            onValueChange = { draft = draft.copy(bic = it.uppercase().take(11)) },
            error = errors["bic"],
            hint = stringResource(R.string.accounts_field_bic_hint),
            capitalization = KeyboardCapitalization.Characters,
        )
        Text(stringResource(R.string.accounts_field_colour), style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            ColorSwatch(color = "", selected = draft.color.isBlank()) { draft = draft.copy(color = "") }
            COLOR_PALETTE.forEach { hex ->
                ColorSwatch(color = hex, selected = draft.color.equals(hex, ignoreCase = true)) {
                    draft =
                        draft.copy(color = hex)
                }
            }
        }
        errors["color"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Text(
            stringResource(R.string.accounts_logo_browser),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ColorSwatch(
    color: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val fill = if (color.isBlank()) MaterialTheme.colorScheme.surfaceVariant else parseColor(color, MaterialTheme.colorScheme.primary)
    val border = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outlineVariant
    Box(
        Modifier
            .size(30.dp)
            .clip(CircleShape)
            .background(fill)
            .border(if (selected) 2.dp else 1.dp, border, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Icon(
                Icons.Outlined.Check,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = if (color.isBlank()) MaterialTheme.colorScheme.onSurface else Color.White,
            )
        }
    }
}
