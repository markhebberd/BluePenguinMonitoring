package nz.co.penguinmonitor.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import nz.co.penguinmonitor.ui.overview.OverviewScreen
import nz.co.penguinmonitor.ui.settings.SettingsScreen
import nz.co.penguinmonitor.ui.singlebox.SingleBoxScreen

@Composable
fun PenguinMonitorNavHost() {
    val navController = rememberNavController()
    val screens = listOf(Screen.Settings, Screen.SingleBox, Screen.Overview)

    Scaffold(
        bottomBar = {
            NavigationBar {
                val navBackStackEntry by navController.currentBackStackEntryAsState()
                val currentDestination = navBackStackEntry?.destination

                screens.forEach { screen ->
                    NavigationBarItem(
                        icon = { Icon(screen.icon, contentDescription = screen.label) },
                        label = { Text(screen.label) },
                        selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true,
                        onClick = {
                            navController.navigate(screen.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Screen.SingleBox.route,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Screen.Settings.route) {
                SettingsScreen()
            }
            composable(Screen.SingleBox.route) {
                SingleBoxScreen(
                    onNavigateToBox = { boxName ->
                        // Navigate handled internally by SingleBoxViewModel
                    }
                )
            }
            composable(Screen.Overview.route) {
                OverviewScreen(
                    onBoxSelected = { boxName ->
                        navController.navigate(Screen.SingleBox.route) {
                            popUpTo(navController.graph.findStartDestination().id) {
                                saveState = true
                            }
                            launchSingleTop = true
                            restoreState = true
                        }
                    }
                )
            }
        }
    }
}
