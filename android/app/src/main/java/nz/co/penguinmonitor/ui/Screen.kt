package nz.co.penguinmonitor.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

sealed class Screen(val route: String, val label: String, val icon: ImageVector) {
    data object Settings : Screen("settings", "Settings", Icons.Default.Settings)
    data object SingleBox : Screen("single_box", "Box Data", Icons.Default.Inbox)
    data object Overview : Screen("overview", "Overview", Icons.Default.GridView)
}
