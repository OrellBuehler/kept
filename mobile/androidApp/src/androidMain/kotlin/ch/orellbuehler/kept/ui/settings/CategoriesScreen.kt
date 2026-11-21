package ch.orellbuehler.kept.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CardGiftcard
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.DirectionsCar
import androidx.compose.material.icons.outlined.Flight
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Label
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.School
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.orellbuehler.kept.FormBody
import ch.orellbuehler.kept.KeptSdk
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.ApiJson
import ch.orellbuehler.kept.model.CategoriesApplyResult
import ch.orellbuehler.kept.model.CategoriesCategory
import ch.orellbuehler.kept.model.CategoriesPage
import ch.orellbuehler.kept.model.CategoriesRule
import ch.orellbuehler.kept.model.load
import ch.orellbuehler.kept.ui.common.PageViewModel
import ch.orellbuehler.kept.ui.common.UiEvent
import ch.orellbuehler.kept.ui.common.keptViewModel
import ch.orellbuehler.kept.ui.components.Choice
import ch.orellbuehler.kept.ui.components.ChoiceField
import ch.orellbuehler.kept.ui.components.ConfirmDialog
import ch.orellbuehler.kept.ui.components.FormSheet
import ch.orellbuehler.kept.ui.components.FormTextField
import ch.orellbuehler.kept.ui.components.IconBadge
import ch.orellbuehler.kept.ui.components.PageScaffold
import ch.orellbuehler.kept.ui.components.Pill
import ch.orellbuehler.kept.ui.components.RowDivider
import ch.orellbuehler.kept.ui.components.ScrollColumn
import ch.orellbuehler.kept.ui.components.SectionCard
import ch.orellbuehler.kept.ui.components.parseColor
import ch.orellbuehler.kept.ui.nav.Navigator

class CategoriesViewModel(
    sdk: KeptSdk,
) : PageViewModel<CategoriesPage>(sdk, { it.load("settings/categories") }) {
    fun saveCategory(
        id: String?,
        values: CategoryFormValues,
    ) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        form.set("id", id)
        submit("settings/categories", if (id == null) "createCategory" else "updateCategory", form)
    }

    fun deleteCategory(id: String) {
        submit("settings/categories", "deleteCategory", FormBody().set("id", id), showRefusal = true)
    }

    fun saveRule(
        id: String?,
        values: RuleFormValues,
    ) {
        val form = FormBody()
        values.fields().forEach { (name, value) -> form.set(name, value) }
        form.set("id", id)
        submit("settings/categories", if (id == null) "createRule" else "updateRule", form)
    }

    fun deleteRule(id: String) {
        submit("settings/categories", "deleteRule", FormBody().set("id", id), showRefusal = true)
    }

    /** Runs the rules over the uncategorized transactions; [describe] turns the answer into the message to show. */
    fun applyRules(describe: (CategoriesApplyResult) -> String) {
        submit("settings/categories", "applyRules", showRefusal = true) { response ->
            val result = runCatching { ApiJson.decodeFromString<CategoriesApplyResult>(response.json) }.getOrNull()
            if (result != null) message(describe(result))
        }
    }
}

/** The categories that sort transactions, and the rules that categorize them on import. */
@Composable
fun CategoriesScreen(nav: Navigator) {
    val vm = keptViewModel { CategoriesViewModel(it) }
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.formErrors.collectAsStateWithLifecycle()
    val resources = LocalContext.current.resources
    var categorySheet by rememberSaveable { mutableStateOf<String?>(null) }
    var ruleSheet by rememberSaveable { mutableStateOf<String?>(null) }
    var deleteCategory by rememberSaveable { mutableStateOf<String?>(null) }
    var deleteRule by rememberSaveable { mutableStateOf<String?>(null) }

    PageScaffold(
        title = stringResource(R.string.categories_title),
        state = state,
        onRefresh = vm::refresh,
        onBack = nav::back,
        events = vm.events,
        onEvent = { event ->
            if (event is UiEvent.Saved) {
                categorySheet = null
                ruleSheet = null
            }
        },
    ) { page, padding ->
        ScrollColumn(padding) {
            CategoriesCard(
                page = page,
                onAdd = {
                    vm.clearFormErrors()
                    categorySheet = ""
                },
                onEdit = {
                    vm.clearFormErrors()
                    categorySheet = it.id
                },
                onDelete = { deleteCategory = it.id },
            )
            RulesCard(
                page = page,
                busy = busy,
                onAdd = {
                    vm.clearFormErrors()
                    ruleSheet = ""
                },
                onEdit = {
                    vm.clearFormErrors()
                    ruleSheet = it.id
                },
                onDelete = { deleteRule = it.id },
                onApply = {
                    vm.applyRules { result ->
                        resources.getQuantityString(R.plurals.categories_applied, result.scanned, result.categorized, result.scanned)
                    }
                },
            )
        }

        categorySheet?.let { id ->
            val category = page.categories.firstOrNull { it.id == id }
            CategorySheet(
                category = category,
                categories = page.categories,
                busy = busy,
                errors = errors,
                onDismiss = { categorySheet = null },
                onSave = { vm.saveCategory(category?.id, it) },
            )
        }
        ruleSheet?.let { id ->
            val rule = page.rules.firstOrNull { it.id == id }
            RuleSheet(
                rule = rule,
                categories = page.categories,
                busy = busy,
                errors = errors,
                onDismiss = { ruleSheet = null },
                onSave = { vm.saveRule(rule?.id, it) },
            )
        }
        deleteCategory?.let { id ->
            val category = page.categories.firstOrNull { it.id == id }
            if (category == null) {
                deleteCategory = null
            } else {
                ConfirmDialog(
                    title = stringResource(R.string.categories_delete_title, category.name),
                    text = stringResource(R.string.categories_delete_text),
                    confirmLabel = stringResource(R.string.delete),
                    onConfirm = { vm.deleteCategory(id) },
                    onDismiss = { deleteCategory = null },
                )
            }
        }
        deleteRule?.let { id ->
            ConfirmDialog(
                title = stringResource(R.string.categories_delete_rule_title),
                text = stringResource(R.string.categories_delete_rule_text),
                confirmLabel = stringResource(R.string.delete),
                onConfirm = { vm.deleteRule(id) },
                onDismiss = { deleteRule = null },
            )
        }
    }
}

@Composable
private fun CategoriesCard(
    page: CategoriesPage,
    onAdd: () -> Unit,
    onEdit: (CategoriesCategory) -> Unit,
    onDelete: (CategoriesCategory) -> Unit,
) {
    SectionCard(
        title = stringResource(R.string.categories_section),
        subtitle = stringResource(R.string.categories_section_text),
        trailing = {
            TextButton(onClick = onAdd) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.categories_add), modifier = Modifier.padding(start = 4.dp))
            }
        },
        contentPadding = false,
    ) {
        if (page.categories.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.categories_empty_title), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.categories_empty_text),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        page.categories.forEachIndexed { index, category ->
            if (index > 0) RowDivider()
            CategoryRow(category, onEdit = { onEdit(category) }, onDelete = { onDelete(category) })
        }
    }
}

@Composable
private fun CategoryRow(
    category: CategoriesCategory,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val tint = parseColor(category.color, MaterialTheme.colorScheme.primary)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onEdit)
            .padding(start = if (category.parentId != null) 40.dp else 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBadge(categoryIcon(category.icon), tint = tint)
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(category.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
            Text(
                pluralStringResource(R.plurals.categories_transactions, category.transactionCount, category.transactionCount),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Pill(stringResource(if (category.kind == "income") R.string.categories_income else R.string.categories_expense))
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.edit)) },
                    onClick = {
                        menu = false
                        onEdit()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

@Composable
private fun RulesCard(
    page: CategoriesPage,
    busy: Boolean,
    onAdd: () -> Unit,
    onEdit: (CategoriesRule) -> Unit,
    onDelete: (CategoriesRule) -> Unit,
    onApply: () -> Unit,
) {
    SectionCard(
        title = stringResource(R.string.categories_rules),
        subtitle = stringResource(R.string.categories_rules_text),
        contentPadding = false,
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onApply, enabled = !busy && page.rules.isNotEmpty()) {
                Icon(Icons.Outlined.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.categories_apply), modifier = Modifier.padding(start = 4.dp))
            }
            OutlinedButton(onClick = onAdd, enabled = page.categories.isNotEmpty()) {
                Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.categories_add_rule), modifier = Modifier.padding(start = 4.dp))
            }
        }
        if (page.rules.isEmpty()) {
            Text(
                stringResource(if (page.categories.isEmpty()) R.string.categories_rules_need_category else R.string.categories_rules_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        page.rules.forEach { rule ->
            RowDivider()
            RuleRow(rule, page.categories, onEdit = { onEdit(rule) }, onDelete = { onDelete(rule) })
        }
    }
}

@Composable
private fun RuleRow(
    rule: CategoriesRule,
    categories: List<CategoriesCategory>,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val category = categories.firstOrNull { it.id == rule.categoryId }
    val target = if (category != null) categoryLabel(category, categories) else rule.categoryName
    val conditions =
        ruleConditions(rule).map { condition ->
            when (condition) {
                is RuleCondition.CounterpartyContains -> stringResource(R.string.categories_cond_counterparty, condition.text)
                is RuleCondition.DescriptionContains -> stringResource(R.string.categories_cond_description, condition.text)
                is RuleCondition.IbanIs -> stringResource(R.string.categories_cond_iban, condition.iban)
                RuleCondition.MoneyIn -> stringResource(R.string.categories_cond_in)
                RuleCondition.MoneyOut -> stringResource(R.string.categories_cond_out)
            }
        }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onEdit).padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.categories_rule_if, conditions.joinToString(stringResource(R.string.categories_and))),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                stringResource(R.string.categories_rule_then, target, rule.priority),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.more_actions))
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.edit)) },
                    onClick = {
                        menu = false
                        onEdit()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CategorySheet(
    category: CategoriesCategory?,
    categories: List<CategoriesCategory>,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSave: (CategoryFormValues) -> Unit,
) {
    val initial = remember(category?.id) { CategoryFormValues.of(category) }
    var name by rememberSaveable { mutableStateOf(initial.name) }
    var kind by rememberSaveable { mutableStateOf(initial.kind) }
    var parentId by rememberSaveable { mutableStateOf(initial.parentId) }
    var color by rememberSaveable { mutableStateOf(initial.color) }
    var icon by rememberSaveable { mutableStateOf(initial.icon) }
    val parents = parentChoices(categories, kind, category?.id)
    val parent = validParent(parentId, parents)
    val none = stringResource(R.string.none)
    FormSheet(
        title = stringResource(if (category == null) R.string.categories_add_title else R.string.categories_edit_title),
        onDismiss = onDismiss,
        onSubmit = { onSave(CategoryFormValues(name, kind, parent, color, icon)) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (category == null) R.string.categories_add else R.string.save),
    ) {
        FormTextField(
            label = stringResource(R.string.categories_name),
            value = name,
            onValueChange = { name = it.take(60) },
            error = errors["name"],
            placeholder = stringResource(R.string.categories_name_example),
        )
        ChoiceField(
            label = stringResource(R.string.categories_type),
            options =
                CATEGORY_KINDS.map {
                    Choice(
                        it,
                        stringResource(
                            if (it ==
                                "income"
                            ) {
                                R.string.categories_income
                            } else {
                                R.string.categories_expense
                            },
                        ),
                    )
                },
            selected = kind,
            onSelect = { kind = it },
            error = errors["kind"],
        )
        ChoiceField(
            label = stringResource(R.string.categories_parent),
            options = listOf(Choice("", none)) + parents.map { Choice(it.id, it.name) },
            selected = parent,
            onSelect = { parentId = it },
            error = errors["parentId"],
        )
        Text(stringResource(R.string.categories_colour), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedChoice(selected = color.isEmpty(), onClick = { color = "" }) {
                Text(
                    stringResource(R.string.none),
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            CATEGORY_COLORS.forEach { swatch ->
                val tint = parseColor(swatch, MaterialTheme.colorScheme.primary)
                Box(
                    Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(tint)
                        .clickable { color = swatch },
                    contentAlignment = Alignment.Center,
                ) {
                    if (color.equals(swatch, ignoreCase = true)) {
                        Icon(Icons.Outlined.Check, contentDescription = swatch, tint = Color.White, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
        errors["color"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Text(stringResource(R.string.categories_icon), style = MaterialTheme.typography.labelLarge)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedChoice(selected = icon.isEmpty(), onClick = { icon = "" }) {
                Text(
                    stringResource(R.string.categories_icon_default),
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            CATEGORY_ICON_NAMES.forEach { iconName ->
                OutlinedChoice(selected = icon == iconName, onClick = { icon = iconName }) {
                    Icon(categoryIcon(iconName), contentDescription = iconName, modifier = Modifier.size(20.dp))
                }
            }
        }
        errors["icon"]?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun OutlinedChoice(
    selected: Boolean,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val border = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        border = BorderStroke(if (selected) 2.dp else 1.dp, border),
        color = Color.Transparent,
        modifier = Modifier.height(32.dp),
    ) {
        Box(Modifier.padding(horizontal = 6.dp), contentAlignment = Alignment.Center) { content() }
    }
}

@Composable
private fun RuleSheet(
    rule: CategoriesRule?,
    categories: List<CategoriesCategory>,
    busy: Boolean,
    errors: Map<String, String>,
    onDismiss: () -> Unit,
    onSave: (RuleFormValues) -> Unit,
) {
    val initial = remember(rule?.id) { RuleFormValues.of(rule, categories) }
    var categoryId by rememberSaveable { mutableStateOf(initial.categoryId) }
    var priority by rememberSaveable { mutableStateOf(initial.priority) }
    var counterparty by rememberSaveable { mutableStateOf(initial.counterpartyContains) }
    var description by rememberSaveable { mutableStateOf(initial.descriptionContains) }
    var iban by rememberSaveable { mutableStateOf(initial.counterpartyIban) }
    var sign by rememberSaveable { mutableStateOf(initial.amountSign) }
    FormSheet(
        title = stringResource(if (rule == null) R.string.categories_add_rule_title else R.string.categories_edit_rule_title),
        onDismiss = onDismiss,
        onSubmit = { onSave(RuleFormValues(categoryId, priority, counterparty, description, iban, sign)) },
        busy = busy,
        error = errors["form"],
        submitLabel = stringResource(if (rule == null) R.string.categories_add_rule else R.string.save),
    ) {
        Text(
            stringResource(R.string.categories_rule_text),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FormTextField(
            label = stringResource(R.string.categories_rule_counterparty),
            value = counterparty,
            onValueChange = { counterparty = it.take(100) },
            error = errors["counterpartyContains"],
        )
        FormTextField(
            label = stringResource(R.string.categories_rule_description),
            value = description,
            onValueChange = { description = it.take(100) },
            error = errors["descriptionContains"],
        )
        FormTextField(
            label = stringResource(R.string.categories_rule_iban),
            value = iban,
            onValueChange = { iban = it.take(42) },
            error = errors["counterpartyIban"],
        )
        ChoiceField(
            label = stringResource(R.string.categories_rule_direction),
            options =
                listOf(
                    Choice("", stringResource(R.string.categories_direction_any)),
                    Choice("expense", stringResource(R.string.categories_direction_out)),
                    Choice("income", stringResource(R.string.categories_direction_in)),
                ),
            selected = sign,
            onSelect = { sign = it },
            error = errors["amountSign"],
        )
        ChoiceField(
            label = stringResource(R.string.categories_rule_category),
            options = categories.map { Choice(it.id, categoryLabel(it, categories)) },
            selected = categoryId,
            onSelect = { categoryId = it },
            error = errors["categoryId"],
        )
        FormTextField(
            label = stringResource(R.string.categories_rule_priority),
            value = priority,
            onValueChange = { priority = it.filter { c -> c.isDigit() }.take(4) },
            error = errors["priority"],
            hint = stringResource(R.string.categories_rule_priority_hint),
            keyboardType = KeyboardType.Number,
        )
    }
}

/** The Material icon for a category's icon name; a label for a category without one. */
fun categoryIcon(name: String?): ImageVector =
    when (name) {
        "shopping-cart" -> Icons.Outlined.ShoppingCart
        "house" -> Icons.Outlined.Home
        "utensils" -> Icons.Outlined.Restaurant
        "car" -> Icons.Outlined.DirectionsCar
        "heart-pulse" -> Icons.Outlined.MonitorHeart
        "plane" -> Icons.Outlined.Flight
        "film" -> Icons.Outlined.Movie
        "graduation-cap" -> Icons.Outlined.School
        "shield" -> Icons.Outlined.Shield
        "receipt" -> Icons.Outlined.Receipt
        "wallet" -> Icons.Outlined.AccountBalanceWallet
        "gift" -> Icons.Outlined.CardGiftcard
        else -> Icons.Outlined.Label
    }
