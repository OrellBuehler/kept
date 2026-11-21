package ch.orellbuehler.kept.ui.bills

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import ch.orellbuehler.kept.model.BillNewPage
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.nav.Navigator
import ch.orellbuehler.kept.ui.theme.kept
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class BillNewViewModel(
    sdk: KeptSdk,
    private val document: MutableStateFlow<String?> = MutableStateFlow(null),
) : PageViewModel<BillNewPage>(sdk, { it.load("bills/new", document.value?.let { id -> mapOf("document" to id) }.orEmpty()) }) {
    val documentId: StateFlow<String?> = document.asStateFlow()

    fun openDocument(id: String) {
        document.value = id
        refresh()
    }

    fun upload(prep: UploadPrep.Ready) {
        submit(
            "bills/new",
            "upload",
            FormBody().file("file", prep.fileName, "application/pdf", prep.base64),
            reload = false,
        )
    }

    fun create(
        values: BillFormValues,
        documentId: String?,
    ) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        form.set("documentId", documentId)
        submit("bills/new", "create", form, reload = false)
    }

    fun notify(text: String) = message(text)
}

/** Adds a bill: first an optional document that pre-fills the form, then the form itself. */
@Composable
fun BillNewScreen(nav: Navigator) {
    val vm = keptViewModel { BillNewViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    PageScaffold(
        title = stringResource(R.string.bills_new_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event ->
            if (event is UiEvent.Navigate) {
                val document = documentIdOfRedirect(event.webPath)
                if (document != null) vm.openDocument(document) else nav.openWebPath(event.webPath, replace = true)
            }
        },
    ) { page, padding ->
        ScrollColumn(padding) {
            NewBillContent(page, vm, busy, errors)
        }
    }
}

@Composable
private fun NewBillContent(
    page: BillNewPage,
    vm: BillNewViewModel,
    busy: Boolean,
    errors: Map<String, String>,
) {
    var manual by rememberSaveable { mutableStateOf(false) }
    if (page.documentId == null && !manual) {
        UploadStep(vm, busy, errors, onManual = { manual = true })
        return
    }
    val currency = LocalSession.current?.preferences?.defaultCurrency ?: "CHF"
    val form = rememberBillFormState(page.documentId) { draftToFormValues(page.draft, currency) }
    when (page.extraction?.source) {
        "qr" ->
            Banner(
                stringResource(R.string.bills_new_from_qr),
                stringResource(R.string.bills_new_from_qr_text),
                MaterialTheme.kept.positive,
                true,
            )
        "text" ->
            Banner(
                stringResource(R.string.bills_new_from_text),
                stringResource(R.string.bills_new_from_text_text),
                MaterialTheme.kept.warning,
                false,
            )
        "none" -> Banner(stringResource(R.string.bills_new_nothing), stringResource(R.string.bills_new_nothing_text), null, null)
    }
    page.extraction?.warnings.orEmpty().forEach { warning ->
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = MaterialTheme.kept.warning, modifier = Modifier.size(18.dp))
            HintText(warning)
        }
    }
    SectionCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BillFormFields(form, page.accounts, errors)
            billFormError(errors)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(
                onClick = { vm.create(form.values, page.documentId) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(R.string.bills_new_save))
                }
            }
        }
    }
    if (page.documentId != null) HintText(stringResource(R.string.bills_new_attached))
}

@Composable
private fun UploadStep(
    vm: BillNewViewModel,
    busy: Boolean,
    errors: Map<String, String>,
    onManual: () -> Unit,
) {
    val tooLarge = stringResource(R.string.bills_upload_too_large)
    val notSupported = stringResource(R.string.bills_upload_not_supported)
    val unreadable = stringResource(R.string.bills_upload_unreadable)
    val source =
        rememberDocumentSource { prep ->
            when (prep) {
                is UploadPrep.Ready -> vm.upload(prep)
                UploadPrep.TooLarge -> vm.notify(tooLarge)
                UploadPrep.NotSupported -> vm.notify(notSupported)
                UploadPrep.Unreadable -> vm.notify(unreadable)
            }
        }
    val working = busy || source.reading
    SectionCard(title = stringResource(R.string.bills_new_upload_title), subtitle = stringResource(R.string.bills_new_upload_text)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (working) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.bills_new_reading))
                }
            }
            (errors["file"] ?: errors["form"])?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = source.pickFile, enabled = !working, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.UploadFile, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_choose_file), modifier = Modifier.padding(start = 8.dp))
            }
            OutlinedButton(onClick = source.takePhoto, enabled = !working, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.PhotoCamera, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_take_photo), modifier = Modifier.padding(start = 8.dp))
            }
            HintText(stringResource(R.string.bills_new_ebill_hint))
            OutlinedButton(onClick = onManual, enabled = !working, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.EditNote, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.bills_enter_manually), modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

@Composable
private fun Banner(
    title: String,
    text: String,
    tint: androidx.compose.ui.graphics.Color?,
    success: Boolean?,
) {
    SectionCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(
                when (success) {
                    true -> Icons.Outlined.CheckCircle
                    false -> Icons.Outlined.WarningAmber
                    null -> Icons.Outlined.Info
                },
                contentDescription = null,
                tint = tint ?: MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Column {
                Text(title, style = MaterialTheme.typography.titleSmall)
                HintText(text)
            }
        }
    }
}
