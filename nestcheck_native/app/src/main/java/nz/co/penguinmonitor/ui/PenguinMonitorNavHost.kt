package nz.co.penguinmonitor.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import kotlinx.coroutines.launch
import nz.co.penguinmonitor.ui.overview.OverviewScreen
import nz.co.penguinmonitor.ui.settings.SettingsScreen
import nz.co.penguinmonitor.ui.singlebox.SingleBoxScreen
import nz.co.penguinmonitor.ui.singlebox.SingleBoxViewModel

@Composable
fun PenguinMonitorNavHost() {
    val scrollState = rememberScrollState()
    val scope = rememberCoroutineScope()
    val singleBoxViewModel: SingleBoxViewModel = hiltViewModel()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
    ) {
        // 1. Settings card (collapsible)
        SettingsScreen()

        // 2. Single box data (with action buttons, lock, data entry)
        SingleBoxScreen(viewModel = singleBoxViewModel)

        // 3. Overview grid + breeding dates
        OverviewScreen(
            onBoxSelected = { boxName ->
                singleBoxViewModel.navigateToBox(boxName)
                scope.launch { scrollState.animateScrollTo(0) }
            }
        )
    }
}
