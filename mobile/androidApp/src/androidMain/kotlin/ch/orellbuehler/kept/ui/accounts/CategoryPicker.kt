package ch.orellbuehler.kept.ui.accounts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.model.AccountDetailCategory
import ch.orellbuehler.kept.ui.components.parseColor

/** Parents by name, each followed by its subcategories by name; a subcategory whose parent is missing counts as a parent. */
fun orderedCategories(categories: List<AccountDetailCategory>): List<AccountDetailCategory> {
    val ids = categories.map { it.id }.toSet()
    val roots = categories.filter { it.parentId == null || it.parentId !in ids }.sortedBy { it.name.lowercase() }
    return roots.flatMap { root ->
        listOf(root) + categories.filter { it.parentId == root.id }.sortedBy { it.name.lowercase() }
    }
}

/** Categories whose label contains [query], case-insensitive; everything for a blank query. */
fun filterCategories(
    categories: List<AccountDetailCategory>,
    all: List<AccountDetailCategory>,
    query: String,
): List<AccountDetailCategory> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return categories
    return categories.filter { categoryLabel(it, all).lowercase().contains(needle) }
}

/**
 * A field that shows the chosen category and opens a list to change it, "Uncategorised" included.
 * [onSelect] gets the category id, or null for none.
 */
@Composable
fun CategoryPicker(
    categories: List<AccountDetailCategory>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var open by remember { mutableStateOf(false) }
    val selected = categories.firstOrNull { it.id == selectedId }
    Row(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .clickable(enabled = enabled) { open = true }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(R.string.accounts_category),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (selected != null) CategoryDot(selected)
                Text(
                    selected?.let { categoryLabel(it, categories) } ?: stringResource(R.string.accounts_uncategorised),
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Icon(Icons.Outlined.UnfoldMore, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (open) {
        CategoryPickerSheet(
            categories = categories,
            selectedId = selectedId,
            onSelect = {
                open = false
                if (it != selectedId) onSelect(it)
            },
            onDismiss = { open = false },
        )
    }
}

@Composable
private fun CategoryDot(category: AccountDetailCategory) {
    Box(
        Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(parseColor(category.color, MaterialTheme.colorScheme.outline)),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CategoryPickerSheet(
    categories: List<AccountDetailCategory>,
    selectedId: String?,
    onSelect: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val ordered = remember(categories) { orderedCategories(categories) }
    val shown = remember(ordered, query) { filterCategories(ordered, categories, query) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.navigationBarsPadding().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.accounts_category), style = MaterialTheme.typography.titleLarge)
            if (categories.size > 8) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.accounts_category_search)) },
                    singleLine = true,
                )
            }
            LazyColumn(Modifier.heightIn(max = 480.dp)) {
                if (query.isBlank()) {
                    item {
                        CategoryRow(stringResource(R.string.accounts_uncategorised), null, selectedId == null) { onSelect(null) }
                    }
                }
                items(shown, key = { it.id }) { category ->
                    CategoryRow(categoryLabel(category, categories), category, selectedId == category.id) { onSelect(category.id) }
                }
            }
        }
    }
}

@Composable
private fun CategoryRow(
    label: String,
    category: AccountDetailCategory?,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (category != null) CategoryDot(category) else Box(Modifier.size(10.dp))
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (selected) Icon(Icons.Outlined.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
    }
}
