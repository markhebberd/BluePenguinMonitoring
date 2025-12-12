# PenguinMonitor

**PenguinMonitor** is a .NET MAUI Android application for monitoring penguin breeding activity at colonies in New Zealand. Field researchers use this app to track nest box occupancy, breeding status, and individual bird identification via EID (Electronic ID) chips.

## Overview

This app helps conservation teams:
- Record penguin observations at nest boxes (adults, eggs, chicks)
- Track breeding likelihood and status across a colony
- Identify individual birds using Gallagher HR5 EID Reader via Bluetooth
- Synchronize data with a central server for analysis
- View colony-wide statistics and filter boxes by various criteria

## Features

- **Box Data Entry**: Record nest contents, breeding status, gate status, and notes for each box
- **Overview Dashboard**: View all boxes at a glance with filtering (by breeding status, egg count, etc.)
- **EID Integration**: Connect to Gallagher HR5 reader to scan microchipped penguins
- **GPS Tracking**: Record location accuracy for field verification
- **Data Sync**: Upload observations to server, download latest colony data
- **Historical Data**: Navigate through previous monitoring sessions

## Requirements

- Visual Studio 2022 (or later) with .NET MAUI workload
- Android device with Bluetooth support
- Gallagher HR5 EID Reader (optional, for bird identification)

## Bluetooth Integration

This project includes a working implementation of Bluetooth connectivity with the **Gallagher HR5 EID Reader**, which may serve as a reference for other developers integrating with Gallagher readers.

## License

[MIT License](LICENSE)
