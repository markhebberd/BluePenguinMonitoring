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
    'biometric_comments' => [],
    'unknown_penguins' => [],
    'discrepancies' => [],
    'warnings' => [],
    'date_first' => null,
    'date_last' => null,
];

// Track birds seen per date for multi-box detection
$birdDateBox = []; // pit8 => [date => box]

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
        $obsTime = $date . ' 02:00:00';
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

        // Only skip if there's truly no data at all (no summary row AND no bird rows AND no comments)
        if ($g['summary'] === null && count($g['birds']) === 0 && empty($notes) && !$g['decomm']) {
            $stats['observations_skipped']++;
            continue;
        }

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
                if (!isset($stats['unknown_penguins'][$pit8])) {
                    // Find close matches (1 digit off)
                    $close = [];
                    foreach ($chipLookup as $known => $fullPit) {
                        if (strlen($known) === strlen($pit8)) {
                            $diff = 0;
                            for ($d = 0; $d < strlen($pit8); $d++) { if ($pit8[$d] !== $known[$d]) $diff++; }
                            if ($diff === 1) $close[] = $known . ' (peng#' . ($chipToPeng[$known] ?? '?') . ')';
                        }
                    }
                    $stats['unknown_penguins'][$pit8] = ['count' => 0, 'close' => $close, 'first_date' => $date, 'first_box' => $box];
                }
                $stats['unknown_penguins'][$pit8]['count']++;
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
            $comment = $bird['comment'];

            // Weight range validation
            if ($weight !== null && ($weight < 100 || $weight > 1800)) {
                $stats['warnings'][] = "peng#$pengNum weight={$weight}g out of range (100-1800) on $date box $box";
            }

            // Bird in multiple boxes same day
            if (!isset($birdDateBox[$pit8])) $birdDateBox[$pit8] = [];
            if (isset($birdDateBox[$pit8][$date]) && $birdDateBox[$pit8][$date] !== $box) {
                $stats['warnings'][] = "peng#$pengNum in box {$birdDateBox[$pit8][$date]} AND box $box on $date";
            }
            $birdDateBox[$pit8][$date] = $box;

            // Bird count mismatch check (per group, done once)
            // (handled below after bird loop)

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
                    $stats['discrepancies'][] = [
                        'peng_num' => $pengNum, 'field' => 'chick_size_code',
                        'db_value' => $existing, 'sheet_value' => $sizeCode, 'date' => $date
                    ];
                }
            }

            // Extract flipper length from comment (e.g. "Re-flipper: 132")
            $flipper = null;
            if ($comment && preg_match('/flipper[:\s]*(\d+)/i', $comment, $m)) {
                $flipper = (float)$m[1];
            }

            // Insert/check biometric data (if weight, sex, comment, or flipper observed)
            if (($weight || $sexNorm || $comment || $flipper) && $pengNum) {
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
                        $pdo->prepare("INSERT INTO penguin_biometric_data (peng_num, observation_id, observation_date, weight, right_flipper_length, notes) VALUES (?,?,?,?,?,?)")
                            ->execute([$pengNum, $observationId, $date, $weight, $flipper, $comment ?: null]);
                    }
                    $stats['biometrics_created']++;
                    if ($comment) {
                        $stats['biometric_comments'][] = "peng#$pengNum $date box $box: $comment";
                    }
                }
            }
        }

        // Bird count mismatch
        $birdCount = count($g['birds']);
        if ($g['summary'] && $birdCount > 0 && $g['summary']['adults'] > 0 && $birdCount > $g['summary']['adults']) {
            $stats['warnings'][] = "$date box $box: {$birdCount} bird rows but summary says {$g['summary']['adults']} adults";
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
$summary = $stats;
unset($summary['unknown_penguins'], $summary['discrepancies'], $summary['warnings'], $summary['biometric_comments']);
$summary['discrepancy_count'] = count($stats['discrepancies']);
$summary['warning_count'] = count($stats['warnings']);
$summary['unknown_penguin_count'] = count($stats['unknown_penguins']);
$summary['biometric_comment_count'] = count($stats['biometric_comments']);
echo json_encode($summary, JSON_PRETTY_PRINT) . "\n";

if (count($stats['warnings']) > 0) {
    echo "\n=== WARNINGS ===\n";
    foreach ($stats['warnings'] as $w) {
        echo "  $w\n";
    }
}

if (count($stats['discrepancies']) > 0) {
    echo "\n=== DISCREPANCIES (non-sex) ===\n";
    foreach ($stats['discrepancies'] as $d) {
        if ($d['field'] === 'sex') continue;
        echo "  #{$d['peng_num']} {$d['field']}: DB={$d['db_value']} Sheet={$d['sheet_value']} Date={$d['date']}\n";
    }
}

if (count($stats['biometric_comments']) > 0) {
    echo "\n=== BIOMETRIC COMMENTS IMPORTED ===\n";
    foreach ($stats['biometric_comments'] as $c) {
        echo "  $c\n";
    }
}

if (count($stats['unknown_penguins']) > 0) {
    echo "\n=== UNKNOWN PENGUINS ===\n";
    uasort($stats['unknown_penguins'], function($a, $b) { return $b['count'] - $a['count']; });
    foreach ($stats['unknown_penguins'] as $pit8 => $info) {
        echo "  $pit8: {$info['count']}x (first: {$info['first_date']} box {$info['first_box']})";
        if (!empty($info['close'])) echo " -> " . implode(', ', $info['close']);
        echo "\n";
    }
}

echo "\nDone!\n";
