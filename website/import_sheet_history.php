<?php
/**
 * Import historical observation data from Google Sheets (gid=325619240).
 * Covers 2021-04-07 to 2024-06-10: 47k rows, 246 dates, 151 boxes.
 *
 * Usage:
 *   curl -H 'X-API-Key: ...' 'https://wildwatch.co.nz/penguin-api/import_sheet_history.php'
 *   curl -H 'X-API-Key: ...' 'https://wildwatch.co.nz/penguin-api/import_sheet_history.php?dry_run=1'
 *   curl -H 'X-API-Key: ...' 'https://wildwatch.co.nz/penguin-api/import_sheet_history.php?wipe=1'
 */
require_once 'config.php';
setHeaders();
validateApiKey();
$pdo = getDbConnection();

$dryRun = isset($_GET['dry_run']);
$wipe = isset($_GET['wipe']);
$colonyId = 1;
$observerId = 1;
$monitorPrefix = 'sheet-import';

echo "=== IMPORT SHEET HISTORY ===\n";
echo "Mode: " . ($dryRun ? "DRY RUN" : ($wipe ? "WIPE & REIMPORT" : "IMPORT")) . "\n\n";

// Wipe previous sheet imports if requested
if ($wipe && !$dryRun) {
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    // Delete scans for sheet-imported observations
    $pdo->exec("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename LIKE '{$monitorPrefix}%'");
    // Delete biometric data from sheet imports
    $pdo->exec("DELETE bd FROM penguin_biometric_data bd JOIN observations o ON bd.observation_id = o.observation_id WHERE o.monitor_filename LIKE '{$monitorPrefix}%'");
    // Also delete biometrics without observation_id that were from sheet import (matched by observer)
    // Delete observations
    $pdo->exec("DELETE FROM observations WHERE monitor_filename LIKE '{$monitorPrefix}%'");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    echo "Wiped previous sheet imports\n\n";
}

// 1. Download CSV
$csvUrl = 'https://docs.google.com/spreadsheets/d/1A2j56iz0_VNHiWNJORAzGDqTbZsEd76j-YI_gQZsDEE/export?format=csv&gid=325619240';
$csv = @file_get_contents($csvUrl);
if (!$csv) { $csv = @file_get_contents(__DIR__ . '/sheet_history.csv'); }
if (!$csv) { echo "ERROR: No CSV source\n"; exit; }

// Parse CSV
$handle = fopen('php://temp', 'r+');
fwrite($handle, $csv);
rewind($handle);
$header = fgetcsv($handle);
$rows = [];
while (($row = fgetcsv($handle)) !== false) $rows[] = $row;
fclose($handle);
echo "CSV: " . count($rows) . " rows, " . count($header) . " columns\n";

// 2. Build chip lookup: last8 → pit_id
$chipLookup = [];
$chipToPeng = [];
foreach ($pdo->query("SELECT pit_id, peng_num FROM penguin_chips")->fetchAll() as $c) {
    $short = substr($c['pit_id'], -8);
    $chipLookup[$short] = $c['pit_id'];
    $chipToPeng[$short] = $c['peng_num'];
}
echo "Chip lookup: " . count($chipLookup) . " entries\n\n";

// 3. Parse rows, validate dates, group by (date, box)
$prevDate = null;
$groups = []; // key = "YYYY-MM-DD|box" => { date, box, summary, birds[], decomm }

foreach ($rows as $i => $row) {
    while (count($row) < 11) $row[] = '';
    $dateStr = trim($row[0]);
    if (empty($dateStr)) continue;

    $ts = DateTime::createFromFormat('d/m/y', $dateStr);
    if (!$ts) { echo "ERROR: Bad date '$dateStr' at row " . ($i+2) . "\n"; exit; }
    $date = $ts->format('Y-m-d');

    // Validate chronological ordering
    if ($prevDate && $date < $prevDate) {
        echo "ERROR: Date decrease at row " . ($i+2) . ": $date < $prevDate\n";
        exit;
    }
    $prevDate = $date;

    $boxUsed = strtoupper(trim($row[1]));
    $box = trim($row[2]);
    if (empty($box)) continue;

    $key = "$date|$box";
    if (!isset($groups[$key])) {
        $groups[$key] = ['date' => $date, 'box' => $box, 'summary' => null, 'birds' => [], 'decomm' => false, 'comments' => []];
    }
    $g = &$groups[$key];

    if ($boxUsed === 'DECOMM') $g['decomm'] = true;

    $birdNum = trim($row[6]);
    $adults = trim($row[3]);
    $eggs = trim($row[4]);
    $chicks = trim($row[5]);
    $sex = trim($row[7]);
    $sizeCode = strtoupper(trim($row[8]));
    $weight = trim($row[9]);
    $comment = trim($row[10]);

    if ($comment) $g['comments'][] = $comment;

    if (!empty($birdNum)) {
        // Bird row
        $g['birds'][] = [
            'pit8' => substr(preg_replace('/[^0-9]/', '', $birdNum), -8),
            'sex' => $sex,
            'size_code' => $sizeCode,
            'weight' => $weight,
            'comment' => $comment,
        ];
    } else if ($adults !== '' || $eggs !== '' || $chicks !== '') {
        // Summary row
        $g['summary'] = [
            'adults' => (int)$adults,
            'eggs' => (int)$eggs,
            'chicks' => (int)$chicks,
        ];
    }
}
echo "Grouped into " . count($groups) . " observations\n\n";

// 4. Import
$stats = [
    'observations_created' => 0,
    'observations_skipped' => 0,
    'scans_created' => 0,
    'biometrics_created' => 0,
    'unknown_penguins' => [],
    'discrepancies' => [],
    'date_first' => null,
    'date_last' => null,
];

if (!$dryRun) $pdo->beginTransaction();

try {
    foreach ($groups as $key => $g) {
        $date = $g['date'];
        $box = $g['box'];

        if (!$stats['date_first']) $stats['date_first'] = $date;
        $stats['date_last'] = $date;

        // Ensure location exists
        if (!$dryRun) {
            $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")
                ->execute([$colonyId, $box]);
        }
        $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
        $stmt->execute([$colonyId, $box]);
        $locationId = $stmt->fetchColumn();
        if (!$locationId && $dryRun) { $locationId = -1; } // placeholder for dry run
        if (!$locationId) continue;

        // Check duplicate
        $obsTime = $date . ' 12:00:00';
        $stmt = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND monitor_filename LIKE ?");
        $stmt->execute([$locationId, $obsTime, $monitorPrefix . '%']);
        if ($stmt->fetchColumn()) { $stats['observations_skipped']++; continue; }

        // Build observation data
        $adults = $g['summary']['adults'] ?? count($g['birds']);
        $eggs = $g['summary']['eggs'] ?? 0;
        $chicks = $g['summary']['chicks'] ?? 0;
        $breedingStatus = $g['decomm'] ? 'DCM' : null;
        $notes = implode('; ', array_filter($g['comments']));
        $filename = $monitorPrefix . '-' . $date;

        $observationId = null;
        if (!$dryRun) {
            $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)")
                ->execute([$locationId, $observerId, $obsTime, $adults, $eggs, $chicks, $breedingStatus, null, $notes, $filename]);
            $observationId = $pdo->lastInsertId();
        }
        $stats['observations_created']++;

        // Process bird rows
        foreach ($g['birds'] as $bird) {
            $pit8 = $bird['pit8'];
            if (!isset($chipLookup[$pit8])) {
                $stats['unknown_penguins'][$pit8] = ($stats['unknown_penguins'][$pit8] ?? 0) + 1;
                continue;
            }

            $pitId = $chipLookup[$pit8];
            $pengNum = $chipToPeng[$pit8];

            // Insert scan
            if (!$dryRun && $observationId) {
                $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc) VALUES (?,?,?)")
                    ->execute([$observationId, $pitId, $obsTime]);
            }
            $stats['scans_created']++;

            // Biometric data
            $sex = strtoupper($bird['sex']);
            $sexNorm = null;
            if ($sex === 'M' || $sex === 'UM') $sexNorm = 'M';
            elseif ($sex === 'F' || $sex === 'UF') $sexNorm = 'F';

            $weight = $bird['weight'] !== '' ? (float)$bird['weight'] : null;
            $sizeCode = $bird['size_code'];

            // Check/update chick_size_code on penguin
            if ($sizeCode && $pengNum) {
                $stmt = $pdo->prepare("SELECT chick_size_code FROM penguins WHERE peng_num = ?");
                $stmt->execute([$pengNum]);
                $existing = $stmt->fetchColumn();
                if (!$existing) {
                    if (!$dryRun) {
                        $pdo->prepare("UPDATE penguins SET chick_size_code = ? WHERE peng_num = ?")->execute([$sizeCode, $pengNum]);
                    }
                } elseif ($existing !== $sizeCode && strpos($existing, $sizeCode) !== 0) {
                    // Only flag if sheet value isn't a prefix of DB value (LC vs LCF is fine)
                    $stats['discrepancies'][] = [
                        'peng_num' => $pengNum, 'field' => 'chick_size_code',
                        'db_value' => $existing, 'sheet_value' => $sizeCode, 'date' => $date
                    ];
                }
            }

            // Check sex discrepancy
            if ($sexNorm && $pengNum) {
                $stmt = $pdo->prepare("SELECT sex FROM penguins WHERE peng_num = ?");
                $stmt->execute([$pengNum]);
                $dbSex = $stmt->fetchColumn();
                if ($dbSex && $dbSex !== $sexNorm) {
                    $stats['discrepancies'][] = [
                        'peng_num' => $pengNum, 'field' => 'sex',
                        'db_value' => $dbSex, 'sheet_value' => $sexNorm, 'date' => $date
                    ];
                }
            }

            // Insert/check biometric data (if weight or sex observed)
            if (($weight || $sexNorm) && $pengNum) {
                $stmt = $pdo->prepare("SELECT biometric_id, weight FROM penguin_biometric_data WHERE peng_num = ? AND observation_date = ?");
                $stmt->execute([$pengNum, $date]);
                $existingBio = $stmt->fetch();

                if ($existingBio) {
                    // Compare weight
                    if ($weight && $existingBio['weight'] && abs((float)$existingBio['weight'] - $weight) > 1) {
                        $stats['discrepancies'][] = [
                            'peng_num' => $pengNum, 'field' => 'weight',
                            'db_value' => $existingBio['weight'], 'sheet_value' => $weight, 'date' => $date
                        ];
                    }
                } else {
                    if (!$dryRun) {
                        $pdo->prepare("INSERT INTO penguin_biometric_data (peng_num, observation_id, observation_date, weight) VALUES (?,?,?,?)")
                            ->execute([$pengNum, $observationId, $date, $weight]);
                    }
                    $stats['biometrics_created']++;
                }
            }
        }
    }

    if (!$dryRun) $pdo->commit();
} catch (Exception $e) {
    if (!$dryRun) $pdo->rollBack();
    echo "ERROR: " . $e->getMessage() . "\n";
    echo "Last key: $key\n";
    exit;
}

// Output
echo "=== RESULTS ===\n";
echo json_encode($stats, JSON_PRETTY_PRINT) . "\n";

if (count($stats['discrepancies']) > 0) {
    echo "\n=== DISCREPANCIES ===\n";
    foreach ($stats['discrepancies'] as $d) {
        echo "  #{$d['peng_num']} {$d['field']}: DB={$d['db_value']} Sheet={$d['sheet_value']} Date={$d['date']}\n";
    }
}

if (count($stats['unknown_penguins']) > 0) {
    echo "\n=== UNKNOWN PENGUINS ===\n";
    arsort($stats['unknown_penguins']);
    foreach ($stats['unknown_penguins'] as $pit8 => $count) {
        echo "  $pit8: $count occurrences\n";
    }
}

echo "\nDone!\n";
