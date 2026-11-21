package ch.orellbuehler.kept.ui.bills

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.BillAccountRef
import ch.orellbuehler.kept.ui.components.AmountField
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.DateField
import ch.orellbuehler.kept.ui.components.FormTextField

/** The state of the bill form while it is on screen; survives rotation. */
class BillFormState(
    initial: BillFormValues,
) {
    var values by mutableStateOf(initial)

    companion object {
        val Saver =
            listSaver<BillFormState, String>(
                save = { it.values.toList() },
                restore = { BillFormState(BillFormValues.of(it)) },
            )
    }
}

@Composable
fun rememberBillFormState(
    key: Any?,
    initial: () -> BillFormValues,
): BillFormState = rememberSaveable(key, saver = BillFormState.Saver) { BillFormState(initial()) }

/** The fields of a bill, as the web's bill form: the same names and the same optional ones. */
@Composable
fun BillFormFields(
    state: BillFormState,
    accounts: List<BillAccountRef>,
    errors: Map<String, String>,
    lockKindAndCurrency: Boolean = false,
) {
    val v = state.values
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        ChoiceField(
            label = stringResource(R.string.bills_form_kind),
            options =
                billKinds.map {
                    Choice(it, stringResource(if (it == "credit_note") R.string.bills_kind_credit_note else R.string.bills_kind_invoice))
                },
            selected = v.kind,
            onSelect = { state.values = v.copy(kind = it) },
            error = errors["kind"],
            enabled = !lockKindAndCurrency,
        )
        if (lockKindAndCurrency) {
            HintText(stringResource(R.string.bills_form_locked))
        }
        FormTextField(
            label = stringResource(R.string.bills_form_invoice_number),
            value = v.invoiceNumber,
            onValueChange = { state.values = v.copy(invoiceNumber = it) },
            error = errors["invoiceNumber"],
        )
        FormTextField(
            label = stringResource(R.string.bills_form_creditor),
            value = v.creditorName,
            onValueChange = { state.values = v.copy(creditorName = it) },
            error = errors["creditorName"],
            capitalization = KeyboardCapitalization.Words,
        )
        FormTextField(
            label = stringResource(R.string.bills_form_iban),
            value = v.creditorIban,
            onValueChange = { state.values = v.copy(creditorIban = it) },
            error = errors["creditorIban"],
            capitalization = KeyboardCapitalization.Characters,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AmountField(
                label = stringResource(R.string.bills_form_amount),
                value = v.amount,
                onValueChange = { state.values = v.copy(amount = it) },
                modifier = Modifier.weight(2f),
                error = errors["amount"],
                hint = stringResource(R.string.bills_form_amount_hint),
            )
            FormTextField(
                label = stringResource(R.string.bills_form_currency),
                value = v.currency,
                onValueChange = { state.values = v.copy(currency = it.uppercase().take(3)) },
                modifier = Modifier.weight(1f),
                error = errors["currency"],
                enabled = !lockKindAndCurrency,
                capitalization = KeyboardCapitalization.Characters,
            )
        }
        DateField(
            label = stringResource(R.string.bills_form_issue_date),
            value = v.issueDate,
            onValueChange = { state.values = v.copy(issueDate = it) },
            error = errors["issueDate"],
            optional = true,
        )
        DateField(
            label = stringResource(R.string.bills_form_due_date),
            value = v.dueDate,
            onValueChange = { state.values = v.copy(dueDate = it) },
            error = errors["dueDate"],
            optional = true,
        )
        ChoiceField(
            label = stringResource(R.string.bills_form_reference_type),
            options =
                billReferenceTypes.map {
                    Choice(
                        it,
                        stringResource(
                            when (it) {
                                "QRR" -> R.string.bills_reftype_qrr
                                "SCOR" -> R.string.bills_reftype_scor
                                "NON" -> R.string.bills_reftype_non
                                else -> R.string.bills_reftype_auto
                            },
                        ),
                    )
                },
            selected = v.referenceType,
            onSelect = { state.values = v.copy(referenceType = it) },
            error = errors["referenceType"],
        )
        FormTextField(
            label = stringResource(R.string.bills_form_reference),
            value = v.reference,
            onValueChange = { state.values = v.copy(reference = it) },
            error = errors["reference"],
            capitalization = KeyboardCapitalization.Characters,
        )
        FormTextField(
            label = stringResource(R.string.bills_form_message),
            value = v.message,
            onValueChange = { state.values = v.copy(message = it) },
            error = errors["message"],
        )
        ChoiceField(
            label = stringResource(R.string.bills_form_account),
            options = listOf(Choice("", stringResource(R.string.none))) + accounts.map { Choice(it.id, "${it.name} (${it.currency})") },
            selected = v.expectedAccountId,
            onSelect = { state.values = v.copy(expectedAccountId = it) },
            error = errors["expectedAccountId"],
        )
        FormTextField(
            label = stringResource(R.string.bills_form_tax_year),
            value = v.taxYear,
            onValueChange = { state.values = v.copy(taxYear = it.filter(Char::isDigit).take(4)) },
            error = errors["taxYear"],
            placeholder = stringResource(R.string.bills_form_tax_year_placeholder),
            keyboardType = KeyboardType.Number,
        )
        FormTextField(
            label = stringResource(R.string.bills_form_notes),
            value = v.notes,
            onValueChange = { state.values = v.copy(notes = it) },
            error = errors["notes"],
            singleLine = false,
        )
    }
}
