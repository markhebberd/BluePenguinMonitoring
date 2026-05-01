<?php
/**
 * Public read-only API for the WildWatch dashboard.
 * No API key required - serves colony observation data for display.
 *
 * GET /penguin-api/dashboard.php?view=timeline
 * GET /penguin-api/dashboard.php?view=box&name=42
 * GET /penguin-api/dashboard.php?view=overview
 */
require_once 'config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$pdo = getDbConnection();
$view = $_GET['view'] ?? 'overview';
$colonyId = 1;

switch ($view) {
    case 'timeline':
        handleTimeline($pdo, $colonyId);
        break;
    case 'box':
        handleBox($pdo, $colonyId, $_GET['name'] ?? '');
        break;
    case 'overview':
    default:
        handleOverview($pdo, $colonyId);
}

function handleTimeline($pdo, $colonyId) {
    $sql = "SELECT
                o.observation_time_utc,
                o.monitor_filename,
                ol.location_name AS box_name,
                o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE
            ORDER BY o.observation_time_utc ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();

    // Group into monitor sessions by filename+date
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
        $monitors[$key]['boxes'][$row['box_name']] = [
            'a' => (int)$row['adults'],
            'e' => (int)$row['eggs'],
            'c' => (int)$row['chicks'],
            's' => $row['breeding_status'],
            'g' => $row['gate_status'],
            'n' => $row['notes']
        ];
    }

    // Deduplicate monitors per date - keep the one with most boxes
    $byDate = [];
    foreach (array_values($monitors) as $m) {
        $d = $m['date'];
        if (!isset($byDate[$d]) || count($m['boxes']) > count($byDate[$d]['boxes'])) {
            $byDate[$d] = $m;
        }
    }

    echo json_encode(array_values($byDate));
}

function handleBox($pdo, $colonyId, $boxName) {
    if (empty($boxName)) {
        echo json_encode(['error' => 'name required']);
        return;
    }

    // Get all observations for this box
    $sql = "SELECT
                o.observation_id, o.observation_time_utc, o.monitor_filename,
                o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND ol.location_name = ? AND o.is_deleted = FALSE
            ORDER BY o.observation_time_utc DESC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$colonyId, $boxName]);
    $observations = $stmt->fetchAll();

    // Get scans for each observation
    foreach ($observations as &$obs) {
        $scanSql = "SELECT pc.chip_number AS tag_number, p.sex, p.life_stage
                    FROM penguin_scans ps
                    JOIN penguins p ON ps.penguin_id = p.penguin_id
                    LEFT JOIN penguin_chips pc ON ps.chip_id = pc.chip_id
                    WHERE ps.observation_id = ?";
        $scanStmt = $pdo->prepare($scanSql);
        $scanStmt->execute([$obs['observation_id']]);
        $obs['scans'] = $scanStmt->fetchAll();
        unset($obs['observation_id']);
    }

    // Get location/tag info
    $locSql = "SELECT location_name, rfid_tag_number, rfid_latitude, rfid_longitude, rfid_accuracy
               FROM observation_locations WHERE colony_id = ? AND location_name = ?";
    $locStmt = $pdo->prepare($locSql);
    $locStmt->execute([$colonyId, $boxName]);
    $location = $locStmt->fetch();

    echo json_encode([
        'location' => $location,
        'observations' => $observations
    ]);
}

function handleOverview($pdo, $colonyId) {
    $sql = "SELECT
                COUNT(DISTINCT ol.location_id) as total_boxes,
                COUNT(DISTINCT o.observation_id) as total_observations,
                COUNT(DISTINCT ps.penguin_id) as total_penguins,
                MIN(o.observation_time_utc) as first_obs,
                MAX(o.observation_time_utc) as last_obs
            FROM observation_locations ol
            LEFT JOIN observations o ON o.location_id = ol.location_id AND o.is_deleted = FALSE
            LEFT JOIN penguin_scans ps ON ps.observation_id = o.observation_id
            WHERE ol.colony_id = ?";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$colonyId]);
    $stats = $stmt->fetch();

    echo json_encode($stats);
}
