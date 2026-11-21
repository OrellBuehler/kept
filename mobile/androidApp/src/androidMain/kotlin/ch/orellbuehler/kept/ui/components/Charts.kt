package ch.orellbuehler.kept.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ch.orellbuehler.kept.ui.theme.kept

/**
 * A line over evenly spaced values with a soft fill underneath: net worth, a balance or a price
 * over time. Draws a dashed zero line when the values cross zero. Needs at least two values.
 */
@Composable
fun LineChart(
    values: List<Long>,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
    height: Dp = 140.dp,
) {
    val zeroColor = MaterialTheme.kept.border
    Canvas(modifier.fillMaxWidth().height(height)) {
        if (values.size < 2) return@Canvas
        val min = values.min().toFloat()
        val max = values.max().toFloat()
        val span = (max - min).takeIf { it > 0f } ?: 1f
        val inset = 4.dp.toPx()
        val usable = size.height - 2 * inset

        fun x(index: Int) = size.width * index / (values.size - 1)

        fun y(value: Float) = inset + usable * (1f - (value - min) / span)

        if (min < 0f && max > 0f) {
            val zero = y(0f)
            drawLine(zeroColor, Offset(0f, zero), Offset(size.width, zero), strokeWidth = 1.dp.toPx())
        }
        val line = Path()
        values.forEachIndexed { index, value ->
            if (index == 0) line.moveTo(x(index), y(value.toFloat())) else line.lineTo(x(index), y(value.toFloat()))
        }
        val fill =
            Path().apply {
                addPath(line)
                lineTo(size.width, size.height)
                lineTo(0f, size.height)
                close()
            }
        drawPath(fill, Brush.verticalGradient(listOf(color.copy(alpha = 0.22f), color.copy(alpha = 0f))))
        drawPath(line, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/** A colour from a "#rrggbb" string of the server (category and institution colours), or [fallback]. */
fun parseColor(
    hex: String?,
    fallback: Color,
): Color {
    val value = hex?.removePrefix("#") ?: return fallback
    if (value.length != 6) return fallback
    return value.toLongOrNull(16)?.let { Color(0xFF000000 or it) } ?: fallback
}
