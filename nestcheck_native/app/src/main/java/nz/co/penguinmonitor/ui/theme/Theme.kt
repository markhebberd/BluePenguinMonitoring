package nz.co.penguinmonitor.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColorScheme = lightColorScheme(
    primary = PrimaryBlue,
    onPrimary = CardColor,
    secondary = SuccessGreen,
    onSecondary = CardColor,
    tertiary = WarningYellow,
    error = DangerRed,
    background = LighterGray,
    surface = CardColor,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    outline = BorderColor,
    surfaceVariant = LightGray
)

@Composable
fun PenguinMonitorTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColorScheme,
        typography = Typography,
        shapes = Shapes,
        content = content
    )
}
