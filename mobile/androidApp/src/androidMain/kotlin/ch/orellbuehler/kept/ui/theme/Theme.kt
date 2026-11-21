package ch.orellbuehler.kept.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Colours with a meaning the Material scheme has no slot for. Values follow the web's tokens (src/app.css). */
@Immutable
data class KeptColors(
    val positive: Color,
    val negative: Color,
    val warning: Color,
    val border: Color,
    val charts: List<Color>,
)

private val LightKept =
    KeptColors(
        positive = Color(0xFF0B7A55),
        negative = Color(0xFFD22222),
        warning = Color(0xFFA65C07),
        border = Color(0xFFE2E5E9),
        charts = listOf(Color(0xFF1C9C86), Color(0xFF3B6FE7), Color(0xFFF28D0D), Color(0xFF9354D4), Color(0xFFDE3572)),
    )

private val DarkKept =
    KeptColors(
        positive = Color(0xFF47D7A2),
        negative = Color(0xFFEE6363),
        warning = Color(0xFFF7B545),
        border = Color(0xFF272930),
        charts = listOf(Color(0xFF2BD4B2), Color(0xFF64A0F6), Color(0xFFF5A33D), Color(0xFFA97BE8), Color(0xFFEA6193)),
    )

private val LightColors =
    lightColorScheme(
        primary = Color(0xFF107F6D),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFDCF1ED),
        onPrimaryContainer = Color(0xFF085347),
        secondary = Color(0xFF151924),
        onSecondary = Color(0xFFFAFAFA),
        secondaryContainer = Color(0xFFEFF1F3),
        onSecondaryContainer = Color(0xFF151924),
        tertiary = Color(0xFF3B6FE7),
        onTertiary = Color.White,
        background = Color(0xFFFAFBFC),
        onBackground = Color(0xFF131620),
        surface = Color(0xFFFAFBFC),
        onSurface = Color(0xFF131620),
        surfaceVariant = Color(0xFFEFF1F3),
        onSurfaceVariant = Color(0xFF5D626F),
        surfaceContainerLowest = Color.White,
        surfaceContainerLow = Color(0xFFF6F7F9),
        surfaceContainer = Color(0xFFF2F4F6),
        surfaceContainerHigh = Color(0xFFEFF1F3),
        surfaceContainerHighest = Color(0xFFE8EBEE),
        outline = Color(0xFFC9CDD4),
        outlineVariant = Color(0xFFE2E5E9),
        error = Color(0xFFD22222),
        onError = Color.White,
        errorContainer = Color(0xFFFBE4E4),
        onErrorContainer = Color(0xFF8C1414),
    )

private val DarkColors =
    darkColorScheme(
        primary = Color(0xFF26D9B5),
        onPrimary = Color(0xFF042521),
        primaryContainer = Color(0xFF0E3B34),
        onPrimaryContainer = Color(0xFFA6F0E0),
        secondary = Color(0xFFF3F4F6),
        onSecondary = Color(0xFF13151B),
        secondaryContainer = Color(0xFF22242A),
        onSecondaryContainer = Color(0xFFF3F4F6),
        tertiary = Color(0xFF64A0F6),
        onTertiary = Color(0xFF0A1B33),
        background = Color(0xFF0E0F13),
        onBackground = Color(0xFFF3F4F6),
        surface = Color(0xFF0E0F13),
        onSurface = Color(0xFFF3F4F6),
        surfaceVariant = Color(0xFF22242A),
        onSurfaceVariant = Color(0xFFA1A5AF),
        surfaceContainerLowest = Color(0xFF0B0C0F),
        surfaceContainerLow = Color(0xFF121318),
        surfaceContainer = Color(0xFF15161C),
        surfaceContainerHigh = Color(0xFF1B1D23),
        surfaceContainerHighest = Color(0xFF22242A),
        outline = Color(0xFF3A3D46),
        outlineVariant = Color(0xFF272930),
        error = Color(0xFFEE6363),
        onError = Color(0xFF2B0A0A),
        errorContainer = Color(0xFF4A1616),
        onErrorContainer = Color(0xFFF9C6C6),
    )

private val KeptShapes =
    Shapes(
        extraSmall = RoundedCornerShape(6.dp),
        small = RoundedCornerShape(8.dp),
        medium = RoundedCornerShape(12.dp),
        large = RoundedCornerShape(16.dp),
        extraLarge = RoundedCornerShape(24.dp),
    )

private val LocalKeptColors = staticCompositionLocalOf { LightKept }
private val LocalDark = staticCompositionLocalOf { false }

val MaterialTheme.kept: KeptColors
    @Composable
    @ReadOnlyComposable
    get() = LocalKeptColors.current

/** Background of a card: white on the light page, one step up on the dark one. */
val MaterialTheme.cardSurface: Color
    @Composable
    @ReadOnlyComposable
    get() = if (LocalDark.current) colorScheme.surfaceContainer else colorScheme.surfaceContainerLowest

/** Digits of equal width, so amounts line up in columns. */
const val TABULAR_NUMBERS: String = "tnum"

@Composable
fun KeptTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    CompositionLocalProvider(
        LocalKeptColors provides if (dark) DarkKept else LightKept,
        LocalDark provides dark,
    ) {
        MaterialTheme(
            colorScheme = if (dark) DarkColors else LightColors,
            typography = Typography(),
            shapes = KeptShapes,
            content = content,
        )
    }
}
