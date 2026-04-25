package nz.co.penguinmonitor.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import nz.co.penguinmonitor.ui.overview.OverviewScreen
import nz.co.penguinmonitor.ui.settings.SettingsScreen
import nz.co.penguinmonitor.ui.singlebox.SingleBoxScreen

@Composable
fun PenguinMonitorNavHost() {
    // Single scrollable page with all sections - matches C# layout
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
    ) {
        // 1. Settings card (collapsible)
        SettingsScreen()

        // 2. Single box data (with action buttons, lock, data entry)
        SingleBoxScreen()

        // 3. Overview grid + breeding dates
        OverviewScreen()
    }
}
