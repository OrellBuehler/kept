package ch.orellbuehler.kept.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.R
import ch.orellbuehler.kept.ui.common.Load
import ch.orellbuehler.kept.ui.common.UiEvent
import kotlinx.coroutines.flow.Flow

/**
 * The frame of every screen: title bar, pull to refresh, and the loading / error / data states.
 *
 * [content] gets the loaded data and the padding of a scrolling list (bottom space for the
 * navigation bar included). Put a `LazyColumn(contentPadding = padding)` in it, or use
 * [ScrollColumn] for a short page.
 *
 * @param onBack null on the top-level tabs
 * @param events the view model's events: messages are shown as snackbars, the rest goes to [onEvent]
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> PageScaffold(
    title: String,
    state: Load<T>,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    events: Flow<UiEvent>? = null,
    onEvent: (UiEvent) -> Unit = {},
    content: @Composable (data: T, padding: PaddingValues) -> Unit,
) {
    val snackbar = remember { SnackbarHostState() }
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    if (events != null) {
        LaunchedEffect(events) {
            events.collect { event ->
                if (event is UiEvent.Message) {
                    if (event.text.isNotBlank()) snackbar.showSnackbar(event.text)
                } else {
                    onEvent(event)
                }
            }
        }
    }
    Scaffold(
        modifier = modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                        }
                    }
                },
                actions = actions,
                scrollBehavior = scroll,
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = floatingActionButton,
    ) { inner ->
        when (state) {
            Load.Loading ->
                Box(Modifier.fillMaxSize().padding(inner), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            is Load.Failed ->
                MessagePane(
                    icon = if (state.offline) Icons.Outlined.CloudOff else Icons.Outlined.ErrorOutline,
                    title = stringResource(if (state.offline) R.string.error_offline_title else R.string.error_title),
                    text = state.message,
                    modifier = Modifier.padding(inner),
                    action = stringResource(R.string.retry),
                    onAction = onRefresh,
                )
            is Load.Ready ->
                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = onRefresh,
                    modifier = Modifier.fillMaxSize().padding(top = inner.calculateTopPadding()),
                ) {
                    content(
                        state.value,
                        PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = inner.calculateBottomPadding() + 96.dp),
                    )
                }
        }
    }
}

/** A short page that scrolls as a whole, with the standard spacing between its cards. */
@Composable
fun ScrollColumn(
    padding: PaddingValues,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(padding),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

/** Centered icon, title and text: an error, or a list with nothing in it yet. */
@Composable
fun MessagePane(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    text: String? = null,
    action: String? = null,
    onAction: () -> Unit = {},
) {
    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (!text.isNullOrBlank()) {
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        if (action != null) Button(onClick = onAction) { Text(action) }
    }
}
