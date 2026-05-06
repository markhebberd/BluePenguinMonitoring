<?php
/**
 * Observations REST API for the WildWatch dashboard
 *
 * GET /penguin-api/observations.php?colony_id=1
 *   Returns all observations grouped by location, sorted by time
 *
 * GET /penguin-api/observations.php?colony_id=1&location=42
 *   Returns observations for a specific box/location
 *
 * GET /penguin-api/observations.php?colony_id=1&summary=1
 *   Returns summary timeline data for the breeding status chart
 */
require_once 'config.php';
setHeaders();
validateApiKey();

$pdo = getDbConnection();
$colonyId = $_GET['colony_id'] ?? 1;
$locationName = $_GET['location'] ?? null;
$summary = isset($_GET['summary']);

if ($summary) {
    handleSummary($pdo, $colonyId);
} elseif ($locationName) {
    handleLocationDetail($pdo, $colonyId, $locationName);
} else {
    handleColonyOverview($pdo, $colonyId);
}

function handleSummary($pdo, $colonyId) {
    // Get all observations with location info, grouped by monitor filename and date
    $sql = "SELECT
                o.observation_time_utc,
                o.monitor_filename,
                ol.location_name,
                o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE
            ORDER BY o.observation_time_utc ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();

    // Group by monitor session (filename + date)
    $monitors = [];
    foreach ($rows as $row) {
        $date = substr($row['observation_time_utc'], 0, 10);
        $key = $row['monitor_filename'] . '|' . $date;
        if (!isset($monitors[$key])) {
            $monitors[$key] = [
                'date' => $date,
                'filename' => $row['monitor_filename'],
                'boxes' => []
            ];
        }
        $monitors[$key]['boxes'][$row['location_name']] = [
            'adults' => (int)$row['adults'],
            'eggs' => (int)$row['eggs'],
            'chicks' => (int)$row['chicks'],
            'breeding_status' => $row['breeding_status'],
            'gate_status' => $row['gate_status'],
            'notes' => $row['notes']
        ];
    }

    echo json_encode([
        'success' => true,
        'data' => array_values($monitors)
    ]);
}

function handleLocationDetail($pdo, $colonyId, $locationName) {
    $sql = "SELECT
                o.observation_id, o.observation_time_utc, o.monitor_filename,
                o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes,
                ob.observer_name
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            JOIN observers ob ON o.observer_id = ob.observer_id
            WHERE ol.colony_id = ? AND ol.location_name = ? AND o.is_deleted = FALSE
            ORDER BY o.observation_time_utc DESC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$colonyId, $locationName]);
    $observations = $stmt->fetchAll();

    // Get scans for each observation
    foreach ($observations as &$obs) {
        $scanSql = "SELECT ps.scan_time_utc, ps.pit_id, pc.peng_num, p.sex, p.life_stage, p.vid_for_scanner
                    FROM penguin_scans ps
                    JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
                    JOIN penguins p ON pc.peng_num = p.peng_num
                    WHERE ps.observation_id = ?
                    ORDER BY ps.scan_time_utc";
        $scanStmt = $pdo->prepare($scanSql);
        $scanStmt->execute([$obs['observation_id']]);
        $obs['scans'] = $scanStmt->fetchAll();
    }

    // Get location info
    $locSql = "SELECT * FROM observation_locations WHERE colony_id = ? AND location_name = ?";
    $locStmt = $pdo->prepare($locSql);
    $locStmt->execute([$colonyId, $locationName]);
    $location = $locStmt->fetch();

    echo json_encode([
        'success' => true,
        'location' => $location,
        'observations' => $observations
    ]);
}

function handleColonyOverview($pdo, $colonyId) {
    // Latest observation per location
    $sql = "SELECT
                ol.location_name,
                ol.rfid_tag_number,
                ol.rfid_latitude,
                ol.rfid_longitude,
                o.observation_time_utc,
                o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes,
                o.monitor_filename,
                (SELECT COUNT(*) FROM observations o2 WHERE o2.location_id = ol.location_id AND o2.is_deleted = FALSE) as total_observations
            FROM observation_locations ol
            LEFT JOIN observations o ON o.observation_id = (
                SELECT o3.observation_id FROM observations o3
                WHERE o3.location_id = ol.location_id AND o3.is_deleted = FALSE
                ORDER BY o3.observation_time_utc DESC LIMIT 1
            )
            WHERE ol.colony_id = ?
            ORDER BY ol.location_name";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$colonyId]);
    $locations = $stmt->fetchAll();

    // Colony stats
    $statsSql = "SELECT
                    COUNT(DISTINCT ol.location_id) as total_locations,
                    COUNT(DISTINCT o.observation_id) as total_observations,
                    COUNT(DISTINCT pc.peng_num) as total_penguins,
                    MIN(o.observation_time_utc) as first_observation,
                    MAX(o.observation_time_utc) as last_observation
                 FROM observation_locations ol
                 LEFT JOIN observations o ON o.location_id = ol.location_id AND o.is_deleted = FALSE
                 LEFT JOIN penguin_scans ps ON ps.observation_id = o.observation_id
                 LEFT JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
                 WHERE ol.colony_id = ?";
    $statsStmt = $pdo->prepare($statsSql);
    $statsStmt->execute([$colonyId]);
    $stats = $statsStmt->fetch();

    echo json_encode([
        'success' => true,
        'stats' => $stats,
        'locations' => $locations
    ]);
}
