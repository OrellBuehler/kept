package ch.orellbuehler.kept.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.ui.common.LocalFormats
import ch.orellbuehler.kept.ui.common.LocalSession
import ch.orellbuehler.kept.ui.theme.TABULAR_NUMBERS
import ch.orellbuehler.kept.ui.theme.cardSurface
import ch.orellbuehler.kept.ui.theme.kept

/** How an amount is coloured. */
enum class AmountTone {
    /** The text colour around it. */
    PLAIN,

    /** Green when positive, red when negative: balances changes, transactions. */
    SIGNED,

    /** Red when negative only: balances. */
    NEGATIVE,
}

/**
 * An amount in minor units, formatted for the user's locale with tabular digits. Hidden behind
 * dots when the user switched "blur amounts" on in Kept.
 */
@Composable
fun AmountText(
    minor: Long,
    currency: String,
    modifier: Modifier = Modifier,
    tone: AmountTone = AmountTone.PLAIN,
    showPlus: Boolean = false,
    style: TextStyle = LocalTextStyle.current,
    fontWeight: FontWeight? = null,
) {
    val formats = LocalFormats.current
    val hidden = LocalSession.current?.preferences?.blurAmounts == true
    val color =
        when {
            tone == AmountTone.SIGNED && minor > 0 -> MaterialTheme.kept.positive
            tone != AmountTone.PLAIN && minor < 0 -> MaterialTheme.kept.negative
            else -> Color.Unspecified
        }
    Text(
        text =
            when {
                hidden -> "$currency •••"
                showPlus -> formats.signedMoney(minor, currency)
                else -> formats.money(minor, currency)
            },
        modifier = modifier,
        color = color,
        style = style.copy(fontFeatureSettings = TABULAR_NUMBERS),
        fontWeight = fontWeight,
        maxLines = 1,
    )
}

/** A card with an optional title row; the web's "Card" on a phone. */
@Composable
fun SectionCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: @Composable (RowScope.() -> Unit)? = null,
    contentPadding: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier =
            modifier.fillMaxWidth().then(
                if (onClick !=
                    null
                ) {
                    Modifier.clip(MaterialTheme.shapes.medium).clickable(onClick = onClick)
                } else {
                    Modifier
                },
            ),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.cardSurface,
        border = BorderStroke(1.dp, MaterialTheme.kept.border),
    ) {
        Column(Modifier.padding(vertical = if (contentPadding) 16.dp else 0.dp)) {
            if (title != null) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = if (contentPadding) 0.dp else 16.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (subtitle != null) {
                            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (trailing != null) trailing()
                }
            }
            Column(Modifier.padding(horizontal = if (contentPadding) 16.dp else 0.dp), content = content)
        }
    }
}

/**
 * A row of a list inside a card or on the page: leading icon or badge, title and subtitle, and a
 * value at the end (usually an amount). The title takes the free width, so a long name never
 * squeezes the value.
 */
@Composable
fun ListRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leading: @Composable (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    showChevron: Boolean = false,
    trailing: @Composable (ColumnScope.() -> Unit)? = null,
) {
    Row(
        modifier =
            modifier
                .fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrBlank()) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            Column(horizontalAlignment = Alignment.End, content = trailing)
        }
        if (showChevron) {
            Spacer(Modifier.width(4.dp))
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A thin line between the rows of a card. */
@Composable
fun RowDivider() {
    HorizontalDivider(color = MaterialTheme.kept.border, thickness = 1.dp)
}

/** "Label ........ value": the details of one thing. */
@Composable
fun KeyValueRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Row(modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
        )
    }
}

/** A round icon on a tinted background, the leading element of a [ListRow]. */
@Composable
fun IconBadge(
    icon: ImageVector,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.primary,
) {
    Box(
        modifier.size(40.dp).clip(CircleShape).background(tint.copy(alpha = 0.12f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

/** A small coloured label: a status, a type, a count. */
@Composable
fun Pill(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(
        text,
        modifier = modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.12f)).padding(horizontal = 8.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall,
        color = color,
        maxLines = 1,
    )
}

/** The heading above a group of rows on the page (outside a card). */
@Composable
fun SectionHeader(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text,
        modifier = modifier.padding(top = 8.dp, bottom = 4.dp),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** A bar that fills with [fraction] (0..1 and beyond): budgets, progress towards a limit. */
@Composable
fun ProgressBar(
    fraction: Float,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Box(
        modifier
            .fillMaxWidth()
            .height(8.dp)
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .height(8.dp)
                .clip(RoundedCornerShape(50))
                .background(color),
        )
    }
}
