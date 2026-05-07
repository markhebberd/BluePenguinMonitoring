<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
$pdo = getDbConnection();
$view = $_GET['view'] ?? 'overview';
$colonyId = 1;
switch ($view) {
    case 'timeline': handleTimeline($pdo, $colonyId); break;
    case 'box': handleBox($pdo, $colonyId, $_GET['name'] ?? ''); break;
    case 'overview': default: handleOverview($pdo, $colonyId);
}

function handleTimeline($pdo, $colonyId) {
    $sql = "SELECT o.observation_time_utc, o.monitor_filename, ol.location_name AS box_name,
                o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes
            FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE ORDER BY o.observation_time_utc ASC";
    $stmt = $pdo->prepare($sql); $stmt->execute([$colonyId]); $rows = $stmt->fetchAll();
    $monitors = [];
    foreach ($rows as $row) {
        $date = substr($row['observation_time_utc'], 0, 10);
        $key = $row['monitor_filename'] . '|' . $date;
        if (!isset($monitors[$key])) $monitors[$key] = ['date' => $date, 'filename' => $row['monitor_filename'], 'boxes' => []];
        $monitors[$key]['boxes'][$row['box_name']] = ['a'=>(int)$row['adults'],'e'=>(int)$row['eggs'],'c'=>(int)$row['chicks'],'s'=>$row['breeding_status'],'g'=>$row['gate_status'],'n'=>$row['notes']];
    }
    $byDate = [];
    foreach (array_values($monitors) as $m) { $d=$m['date']; if (!isset($byDate[$d])||count($m['boxes'])>count($byDate[$d]['boxes'])) $byDate[$d]=$m; }
    echo json_encode(array_values($byDate));
}

function handleBox($pdo, $colonyId, $boxName) {
    if (empty($boxName)) { echo json_encode(['error'=>'name required']); return; }
    $sql = "SELECT o.observation_id, o.observation_time_utc, o.monitor_filename, o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes,
            (SELECT COUNT(*) FROM audit_log a WHERE a.table_name = 'observations' AND a.record_id = o.observation_id AND a.action = 'UPDATE') as edit_count
            FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND ol.location_name = ? AND o.is_deleted = FALSE ORDER BY o.observation_time_utc DESC";
    $stmt = $pdo->prepare($sql); $stmt->execute([$colonyId, $boxName]); $observations = $stmt->fetchAll();
    foreach ($observations as &$obs) {
        $s = $pdo->prepare("SELECT ps.scan_id, ps.pit_id, pc.peng_num, p.sex, p.life_stage, p.chipped_as_adult, p.chick_size_code, pc.chip_date FROM penguin_scans ps JOIN penguin_chips pc ON ps.pit_id = pc.pit_id JOIN penguins p ON pc.peng_num = p.peng_num WHERE ps.observation_id = ?");
        $s->execute([$obs['observation_id']]); $obs['scans'] = $s->fetchAll();
    }
    $l = $pdo->prepare("SELECT location_id, location_name, persistent_notes, pit_id, pit_latitude, pit_longitude, pit_accuracy FROM observation_locations WHERE colony_id = ? AND location_name = ?");
    $l->execute([$colonyId, $boxName]);

    // All penguins associated with this box (unified: scans + chipped)
    $result = getSightings($pdo, null, $boxName, $colonyId);
    $allPenguins = $result['penguins'];

    echo json_encode(['location'=>$l->fetch(), 'observations'=>$observations, 'all_penguins'=>$allPenguins]);
}

function handleOverview($pdo, $colonyId) {
    $now = new DateTime();
    $year = (int)$now->format('n') >= 4 ? (int)$now->format('Y') : (int)$now->format('Y') - 1;
    $seasonStart = "$year-04-01 00:00:00";

    $stmt = $pdo->prepare("SELECT COUNT(*) as c FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id WHERE ol.colony_id = ? AND o.is_deleted = FALSE AND o.observation_time_utc >= ?");
    $stmt->execute([$colonyId, $seasonStart]); $seasonObs = (int)$stmt->fetch()['c'];

    $stmt = $pdo->prepare("SELECT COUNT(DISTINCT pc.peng_num) as c FROM penguin_scans ps JOIN penguin_chips pc ON ps.pit_id = pc.pit_id JOIN observations o ON ps.observation_id = o.observation_id JOIN observation_locations ol ON o.location_id = ol.location_id WHERE ol.colony_id = ? AND o.is_deleted = FALSE AND o.observation_time_utc >= ?");
    $stmt->execute([$colonyId, $seasonStart]); $seasonPenguins = (int)$stmt->fetch()['c'];

    // Latest data per box
    $sql = "SELECT ol.location_name, o.breeding_status, o.adults, o.eggs, o.chicks
            FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE ORDER BY o.observation_time_utc DESC";
    $stmt = $pdo->prepare($sql); $stmt->execute([$colonyId]); $rows = $stmt->fetchAll();

    $boxInfo = []; // name => {s, a, e, c}
    $statusCounts = ['BR'=>0,'CON'=>0,'POT'=>0,'UNL'=>0,'NO'=>0,'ABN'=>0,'DCM'=>0];
    $totalEggs = 0; $totalChicks = 0;

    foreach ($rows as $row) {
        $name = $row['location_name'];
        if (!isset($boxInfo[$name])) {
            $s = $row['breeding_status'] ?: '';
            $boxInfo[$name] = ['s'=>$s, 'a'=>(int)$row['adults'], 'e'=>(int)$row['eggs'], 'c'=>(int)$row['chicks']];
            if (isset($statusCounts[$s])) $statusCounts[$s]++;
            $totalEggs += (int)$row['eggs'];
            $totalChicks += (int)$row['chicks'];
        } elseif ($boxInfo[$name]['s'] === '' && $row['breeding_status']) {
            $boxInfo[$name]['s'] = $row['breeding_status'];
            $statusCounts[$row['breeding_status']] = ($statusCounts[$row['breeding_status']] ?? 0) + 1;
        }
    }

    $stmt = $pdo->prepare("SELECT COUNT(*) as c FROM observation_locations WHERE colony_id = ?");
    $stmt->execute([$colonyId]); $totalBoxes = (int)$stmt->fetch()['c'];

    echo json_encode([
        'total_boxes' => $totalBoxes,
        'season_observations' => $seasonObs,
        'season_penguins' => $seasonPenguins,
        'season_start' => $seasonStart,
        'status_counts' => $statusCounts,
        'total_eggs' => $totalEggs,
        'total_chicks' => $totalChicks,
        'box_info' => $boxInfo,
    ]);
}
