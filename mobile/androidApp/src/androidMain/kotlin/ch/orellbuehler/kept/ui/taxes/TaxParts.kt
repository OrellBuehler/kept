package ch.orellbuehler.kept.ui.taxes

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.TaxBalance
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.theme.kept

/** The outcome of a year: what is due, what comes back, or that nothing is assessed yet. */
@Composable
fun OutcomeText(
    balance: TaxBalance,
    currency: String,
    modifier: Modifier = Modifier,
) {
    val formats = LocalFormats.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (balance.outcome) {
        "due" ->
            Text(
                stringResource(R.string.taxes_outcome_due, formats.money(balance.amountDue, currency)),
                modifier,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        "refund" ->
            Text(
                stringResource(R.string.taxes_outcome_refund, formats.money(balance.refundExpected, currency)),
                modifier,
                color = MaterialTheme.kept.positive,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        "settled" -> Text(stringResource(R.string.taxes_outcome_settled), modifier, color = muted)
        else -> Text(stringResource(R.string.taxes_outcome_unknown), modifier, color = muted)
    }
}

@Composable
fun deductionLabel(type: String): String =
    stringResource(
        when (type) {
            "pillar_3a" -> R.string.taxes_deduction_pillar_3a
            "donations" -> R.string.taxes_deduction_donations
            "medical" -> R.string.taxes_deduction_medical
            "childcare" -> R.string.taxes_deduction_childcare
            "commuting" -> R.string.taxes_deduction_commuting
            "education" -> R.string.taxes_deduction_education
            "debt_interest" -> R.string.taxes_deduction_debt_interest
            "alimony" -> R.string.taxes_deduction_alimony
            else -> R.string.taxes_deduction_other
        },
    )

/** The form of a tax year: its [year] can be typed when adding one and is fixed when editing. */
@Composable
fun TaxYearFormSheet(
    key: Int,
    title: String,
    submitLabel: String,
    initial: TaxYearFormValues,
    yearEditable: Boolean,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSubmit: (TaxYearFormValues) -> Unit,
) {
    var year by rememberSaveable(key) { mutableStateOf(initial.year) }
    var authority by rememberSaveable(key) { mutableStateOf(initial.authority) }
    var currency by rememberSaveable(key) { mutableStateOf(initial.currency) }
    var assessed by rememberSaveable(key) { mutableStateOf(initial.assessedTotal) }
    var notes by rememberSaveable(key) { mutableStateOf(initial.notes) }
    FormSheet(
        title = title,
        onDismiss = onDismiss,
        onSubmit = { onSubmit(TaxYearFormValues(year, authority, currency, assessed, notes)) },
        busy = busy,
        error = errors["form"],
        submitLabel = submitLabel,
    ) {
        if (yearEditable) {
            FormTextField(
                stringResource(R.string.taxes_form_year),
                year,
                { year = it.filter(Char::isDigit).take(4) },
                error = errors["year"],
                keyboardType = KeyboardType.Number,
            )
        }
        FormTextField(
            stringResource(R.string.taxes_form_authority),
            authority,
            { authority = it.take(140) },
            error = errors["authority"],
            placeholder = stringResource(R.string.taxes_form_authority_placeholder),
            capitalization = KeyboardCapitalization.Words,
        )
        FormTextField(
            stringResource(R.string.taxes_form_currency),
            currency,
            { currency = it.take(3).uppercase() },
            error = errors["currency"],
            capitalization = KeyboardCapitalization.Characters,
        )
        AmountField(
            stringResource(R.string.taxes_form_assessed),
            assessed,
            { assessed = it },
            error = errors["assessedTotal"],
            hint = stringResource(R.string.taxes_form_assessed_hint),
        )
        FormTextField(
            stringResource(R.string.taxes_form_notes),
            notes,
            { notes = it.take(2000) },
            error = errors["notes"],
            singleLine = false,
        )
    }
}
