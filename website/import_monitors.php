<?php
/**
 * Import legacy monitor data into the new database schema.
 * Run once via: curl -H 'X-API-Key: ...' https://wildwatch.co.nz/penguin-api/import_monitors.php
 */
require_once 'config.php';
setHeaders();
validateApiKey();

$pdo = getDbConnection();

// Run schema migration first
$schema = file_get_contents(__DIR__ . '/../database_schema.sql');
if (!$schema) {
    // Try alternate path
    $schema = file_get_contents(__DIR__ . '/database_schema.sql');
}

// We can't run multi-statement SQL via PDO easily, so we'll create tables individually
// Instead, assume tables are already created via phpMyAdmin or CLI

// Load monitor JSON
$monitorsJson = file_get_contents(__DIR__ . '/penguin_monitors.json');
if (!$monitorsJson) {
    echo json_encode(['error' => 'penguin_monitors.json not found']);
    exit;
}

$monitors = json_decode($monitorsJson, true);
if (!$monitors) {
    echo json_encode(['error' => 'Failed to parse JSON']);
    exit;
}

$colonyId = 1;
$observerId = 1;
$imported = 0;
$skipped = 0;
$penguinsCreated = 0;
$scansCreated = 0;

// Ensure colony exists
try {
    $pdo->exec("INSERT IGNORE INTO observers (observer_id, observer_name, email, passphrase_hash) VALUES (1, 'legacy_import', 'mark@wildwatch.co.nz', '\$2y\$10\$placeholder')");
    $pdo->exec("INSERT IGNORE INTO regions (region_id, region_name) VALUES (1, 'Nelson/Tasman')");
    $pdo->exec("INSERT IGNORE INTO colonies (colony_id, region_id, colony_name, location_sets_string) VALUES (1, 1, 'Tarakohe', '{1-150,AA-AC},{N1-N6}')");
} catch (Exception $e) {
    // Tables might not exist yet
}

// Create observation_locations from box_tags if they exist
try {
    $stmt = $pdo->query("SELECT * FROM box_tags");
    $boxTags = $stmt->fetchAll();
    foreach ($boxTags as $tag) {
        $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type, rfid_tag_number, rfid_scan_time_utc, rfid_latitude, rfid_longitude, rfid_accuracy) VALUES (?, ?, 'box', ?, ?, ?, ?, ?)")
            ->execute([$colonyId, $tag['box_id'], $tag['tag_number'], $tag['scan_time_utc'], $tag['latitude'], $tag['longitude'], $tag['accuracy']]);
    }
} catch (Exception $e) {
    error_log("Box tags import: " . $e->getMessage());
}

// Process each monitor session
foreach ($monitors as $monitor) {
    if ($monitor['IsDeleted'] ?? false) {
        $skipped++;
        continue;
    }

    $filename = $monitor['filename'] ?? 'unknown';
    $boxDataMap = $monitor['BoxData'] ?? [];

    if (empty($boxDataMap)) {
        $skipped++;
        continue;
    }

    foreach ($boxDataMap as $boxName => $boxData) {
        try {
            // Ensure location exists
            $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")
                ->execute([$colonyId, $boxName]);

            // Get location_id
            $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
            $stmt->execute([$colonyId, $boxName]);
            $locationId = $stmt->fetchColumn();
            if (!$locationId) continue;

            // Parse observation time
            $obsTime = $boxData['whenDataCollectedUtc'] ?? $monitor['LastSaved'] ?? date('Y-m-d H:i:s');
            $obsTimeParsed = date('Y-m-d H:i:s', strtotime($obsTime));

            // Check for duplicate (same location, same time, same observer)
            $stmt = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND observer_id = ?");
            $stmt->execute([$locationId, $obsTimeParsed, $observerId]);
            if ($stmt->fetchColumn()) continue; // Skip duplicate

            // Insert observation
            $stmt = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $locationId,
                $observerId,
                $obsTimeParsed,
                $boxData['Adults'] ?? 0,
                $boxData['Eggs'] ?? 0,
                $boxData['Chicks'] ?? 0,
                $boxData['BreedingChance'] ?? null,
                $boxData['GateStatus'] ?? null,
                $boxData['Notes'] ?? '',
                $filename
            ]);
            $observationId = $pdo->lastInsertId();
            $imported++;

            // Import scanned birds
            $scannedIds = $boxData['ScannedIds'] ?? [];
            foreach ($scannedIds as $scan) {
                $birdId = $scan['BirdId'] ?? '';
                if (empty($birdId)) continue;

                // Look up penguin by chip number
                $stmt = $pdo->prepare("SELECT pc.penguin_id, pc.chip_id FROM penguin_chips pc WHERE pc.chip_number = ?");
                $stmt->execute([$birdId]);
                $chipRow = $stmt->fetch();

                if ($chipRow) {
                    $penguinId = $chipRow['penguin_id'];
                    $chipId = $chipRow['chip_id'];
                } else {
                    // Also check legacy tag_number column
                    $stmt = $pdo->prepare("SELECT penguin_id FROM penguins WHERE tag_number = ?");
                    $stmt->execute([$birdId]);
                    $penguinId = $stmt->fetchColumn();

                    if (!$penguinId) {
                        // Create new penguin + chip
                        $pdo->prepare("INSERT INTO penguins (tag_number) VALUES (?)")
                            ->execute([$birdId]);
                        $penguinId = $pdo->lastInsertId();
                        $penguinsCreated++;
                    }

                    // Ensure chip record exists
                    $pdo->prepare("INSERT IGNORE INTO penguin_chips (penguin_id, chip_number, is_active) VALUES (?, ?, TRUE)")
                        ->execute([$penguinId, $birdId]);
                    $stmt = $pdo->prepare("SELECT chip_id FROM penguin_chips WHERE chip_number = ?");
                    $stmt->execute([$birdId]);
                    $chipId = $stmt->fetchColumn();
                }

                // Insert scan
                $scanTime = $scan['Timestamp'] ?? $obsTimeParsed;
                $scanTimeParsed = date('Y-m-d H:i:s', strtotime($scanTime));

                $pdo->prepare("INSERT INTO penguin_scans (observation_id, penguin_id, chip_id, scan_time_utc, latitude, longitude, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?)")
                    ->execute([
                        $observationId,
                        $penguinId,
                        $chipId,
                        $scanTimeParsed,
                        $scan['Latitude'] ?? null,
                        $scan['Longitude'] ?? null,
                        $scan['Accuracy'] ?? null
                    ]);
                $scansCreated++;
            }
        } catch (Exception $e) {
            error_log("Import error for box $boxName in $filename: " . $e->getMessage());
        }
    }
}

echo json_encode([
    'success' => true,
    'observations_imported' => $imported,
    'monitors_skipped' => $skipped,
    'penguins_created' => $penguinsCreated,
    'scans_created' => $scansCreated,
    'total_monitors' => count($monitors)
], JSON_PRETTY_PRINT);
