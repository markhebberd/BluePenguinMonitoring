<?php
require_once 'config.php';
setHeaders();
$observer = requireAuth();

$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? 1);
requireColonyAccess($pdo, $observer, $colonyId); // view access
$viewPrefix = getColonyPrefix($pdo, $colonyId);
$date = $_GET['date'] ?? '';
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    echo json_encode(['error' => 'date required (YYYY-MM-DD)']);
    exit;
}

// NZ date D covers UTC range: (D-1)T11:00 to DT12:00 (covers both NZST+12 and NZDT+13)
$utcStart = date('Y-m-d 11:00:00', strtotime($date) - 86400);
$utcEnd = date('Y-m-d 12:00:00', strtotime($date));
$stmt = $pdo->prepare("SELECT o.observation_id, o.observation_time_utc, o.adults, o.eggs, o.chicks,
    o.breeding_status, o.gate_status, o.notes, o.observer_id,
    ol.location_name AS box_name, ob.observer_name
    FROM observations o
    JOIN observation_locations ol ON o.location_id = ol.location_id
    LEFT JOIN observers ob ON o.observer_id = ob.observer_id
    WHERE o.observation_time_utc >= ? AND o.observation_time_utc < ?
    AND o.is_deleted = FALSE
    ORDER BY ol.location_name + 0, o.observation_time_utc");
$stmt->execute([$utcStart, $utcEnd]);
$observations = $stmt->fetchAll();

// Scans for these observations
$obsIds = array_column($observations, 'observation_id');
$scans = [];
if (!empty($obsIds)) {
    $ph = implode(',', array_fill(0, count($obsIds), '?'));
    $stmt = $pdo->prepare("SELECT ps.observation_id, pc.peng_num, ps.pit_id, p.sex, p.chipped_as_adult, pc.chip_date, p.chick_size_code
        FROM penguin_scans ps
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
        JOIN penguins p ON pc.peng_num = p.peng_num
        WHERE ps.observation_id IN ($ph) AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
        GROUP BY ps.observation_id, pc.peng_num");
    $stmt->execute(array_values($obsIds));
    foreach ($stmt->fetchAll() as $row) {
        $row['peng_num'] = displayPengNum($row['peng_num'] ?? '', $viewPrefix);
        $scans[$row['observation_id']][] = $row;
    }
}

// Attach scans to observations
foreach ($observations as &$obs) {
    $obs['scans'] = $scans[$obs['observation_id']] ?? [];
}

// Chippings on this date
$stmt = $pdo->prepare("SELECT pc.pit_id, pc.peng_num, pc.chip_box, pc.chip_by, p.sex, p.chipped_as_adult, p.chick_size_code
    FROM penguin_chips pc
    JOIN penguins p ON pc.peng_num = p.peng_num
    WHERE pc.chip_date = ?
    ORDER BY pc.chip_box + 0");
$stmt->execute([$date]);
$chippings = $stmt->fetchAll();
stripPengPrefix($chippings, $viewPrefix);

echo json_encode([
    'date' => $date,
    'observations' => $observations,
    'chippings' => $chippings,
]);
