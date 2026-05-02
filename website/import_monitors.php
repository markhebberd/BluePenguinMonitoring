<?php
require_once 'config.php';
setHeaders();
validateApiKey();
$pdo = getDbConnection();

$monitorsJson = file_get_contents(__DIR__ . '/penguin_monitors.json');
$monitors = json_decode($monitorsJson, true);
if (!$monitors) { echo json_encode(['error' => 'No monitors']); exit; }

$colonyId = 1;
$observerId = 1;
$imported = 0;
$scansCreated = 0;
$scansSkipped = 0;
$boxTagsSkipped = 0;
$unknownPenguins = [];

// Build lookup: chip_number -> penguin_id (from penguin_chips, then tag_number fallback)
$penguinLookup = [];
$stmt = $pdo->query("SELECT penguin_id, chip_number FROM penguin_chips");
foreach ($stmt->fetchAll() as $row) {
    $penguinLookup[strtoupper($row['chip_number'])] = $row['penguin_id'];
}
$stmt = $pdo->query("SELECT penguin_id, tag_number FROM penguins WHERE tag_number IS NOT NULL");
foreach ($stmt->fetchAll() as $row) {
    $short = strtoupper(substr($row['tag_number'], -8));
    if (!isset($penguinLookup[$short])) {
        $penguinLookup[$short] = $row['penguin_id'];
    }
}

foreach ($monitors as $monitor) {
    if ($monitor['IsDeleted'] ?? false) continue;
    $filename = $monitor['filename'] ?? 'unknown';
    
    foreach ($monitor['BoxData'] ?? [] as $boxName => $boxData) {
        try {
            $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")
                ->execute([$colonyId, $boxName]);
            
            $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
            $stmt->execute([$colonyId, $boxName]);
            $locationId = $stmt->fetchColumn();
            if (!$locationId) continue;
            
            $obsTime = $boxData['whenDataCollectedUtc'] ?? $monitor['LastSaved'] ?? date('Y-m-d H:i:s');
            $obsTimeParsed = date('Y-m-d H:i:s', strtotime($obsTime));
            
            // Skip duplicates
            $stmt = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND observer_id = ?");
            $stmt->execute([$locationId, $obsTimeParsed, $observerId]);
            if ($stmt->fetchColumn()) continue;
            
            $stmt = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)");
            $stmt->execute([
                $locationId, $observerId, $obsTimeParsed,
                $boxData['Adults'] ?? 0, $boxData['Eggs'] ?? 0, $boxData['Chicks'] ?? 0,
                $boxData['BreedingChance'] ?? null, $boxData['GateStatus'] ?? null,
                $boxData['Notes'] ?? '', $filename
            ]);
            $observationId = $pdo->lastInsertId();
            $imported++;
            
            foreach ($boxData['ScannedIds'] ?? [] as $scan) {
                $birdId = $scan['BirdId'] ?? '';
                if (empty($birdId)) continue;
                
                $cleanId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $birdId));
                $short8 = strlen($cleanId) >= 8 ? substr($cleanId, -8) : $cleanId;
                
                // Skip box tags
                if (substr($short8, 0, 4) === '9130' || strpos($birdId, 'LA9000250') !== false) {
                    $boxTagsSkipped++;
                    continue;
                }
                
                if (isset($penguinLookup[$short8])) {
                    $penguinId = $penguinLookup[$short8];
                    $scanTime = $scan['Timestamp'] ?? $obsTimeParsed;
                    $scanTimeParsed = date('Y-m-d H:i:s', strtotime($scanTime));
                    
                    $pdo->prepare("INSERT INTO penguin_scans (observation_id, penguin_id, scan_time_utc, latitude, longitude, accuracy) VALUES (?,?,?,?,?,?)")
                        ->execute([$observationId, $penguinId, $scanTimeParsed,
                            $scan['Latitude'] ?? null, $scan['Longitude'] ?? null, $scan['Accuracy'] ?? null]);
                    $scansCreated++;
                } else {
                    $unknownPenguins[$short8] = ($unknownPenguins[$short8] ?? 0) + 1;
                    $scansSkipped++;
                }
            }
        } catch (Exception $e) {
            error_log("Import error box $boxName: " . $e->getMessage());
        }
    }
}

echo json_encode([
    'observations_imported' => $imported,
    'scans_created' => $scansCreated,
    'scans_skipped_unknown' => $scansSkipped,
    'box_tags_skipped' => $boxTagsSkipped,
    'unknown_penguins' => $unknownPenguins,
], JSON_PRETTY_PRINT);
