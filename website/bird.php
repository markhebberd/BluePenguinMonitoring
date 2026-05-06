<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();
$num = $_GET['num'] ?? '';
$tag = $_GET['tag'] ?? '';
if (empty($num) && empty($tag)) { echo json_encode(['error'=>'num or tag required']); exit; }

if (!empty($num)) {
    $stmt = $pdo->prepare("SELECT * FROM penguins WHERE peng_num = ?");
    $stmt->execute([$num]);
    $penguin = $stmt->fetch();
} else {
    // Fallback: lookup by pit_id
    $stmt = $pdo->prepare("SELECT p.* FROM penguins p JOIN penguin_chips pc ON p.peng_num = pc.peng_num WHERE pc.pit_id = ? OR pc.pit_id LIKE ?");
    $stmt->execute([$tag, '%'.$tag]);
    $penguin = $stmt->fetch();
}
if (!$penguin) { echo json_encode(['error'=>'penguin not found']); exit; }

$pid = $penguin['peng_num'];

// Chips
$chipsStmt = $pdo->prepare("SELECT pit_id, chip_date, is_active, chip_box, chip_by, rechip_by, solo FROM penguin_chips WHERE peng_num = ? ORDER BY chip_date");
$chipsStmt->execute([$pid]);
$penguin['chips'] = $chipsStmt->fetchAll();

// All scans with observation context (JOIN through penguin_chips)
$stmt = $pdo->prepare("SELECT ps.scan_time_utc, ps.pit_id, o.observation_id,
    ol.location_name AS box_name, o.observation_time_utc, o.monitor_filename,
    o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes
    FROM penguin_scans ps
    JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
    JOIN observations o ON ps.observation_id = o.observation_id
    JOIN observation_locations ol ON o.location_id = ol.location_id
    WHERE pc.peng_num = ? AND o.is_deleted = FALSE
    ORDER BY ps.scan_time_utc DESC");
$stmt->execute([$pid]);
$scans = $stmt->fetchAll();

// Get co-scanned birds for each observation
$obsIds = array_unique(array_column($scans, 'observation_id'));
$coScans = [];
if (!empty($obsIds)) {
    $placeholders = implode(',', array_fill(0, count($obsIds), '?'));
    $coStmt = $pdo->prepare("SELECT ps.observation_id, pc.peng_num, p.sex, p.chipped_as_adult, pc.pit_id, pc.chip_date
        FROM penguin_scans ps
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
        JOIN penguins p ON pc.peng_num = p.peng_num
        WHERE ps.observation_id IN ($placeholders) AND pc.peng_num != ?
        ORDER BY pc.peng_num + 0");
    $coStmt->execute(array_merge($obsIds, [$pid]));
    foreach ($coStmt->fetchAll() as $row) {
        $coScans[$row['observation_id']][] = $row;
    }
}
foreach ($scans as &$s) {
    $s['seen_with'] = $coScans[$s['observation_id']] ?? [];
}

// Biometrics
$stmt = $pdo->prepare("SELECT * FROM penguin_biometric_data WHERE peng_num = ? ORDER BY observation_date DESC");
$stmt->execute([$pid]);
$biometrics = $stmt->fetchAll();

// Partners (JOIN scans through penguin_chips)
$stmt = $pdo->prepare("SELECT pc2.peng_num AS partner_peng_num, pc2.pit_id AS partner_pit_id, p2.sex AS partner_sex, p2.life_stage AS partner_life_stage, p2.chipped_as_adult AS partner_chipped_as_adult, pc2.chip_date AS partner_chip_date,
    ol.location_name AS box_name, o.observation_time_utc, o.monitor_filename
    FROM penguin_scans ps1
    JOIN penguin_chips pc1 ON ps1.pit_id = pc1.pit_id
    JOIN observations o ON ps1.observation_id = o.observation_id
    JOIN observation_locations ol ON o.location_id = ol.location_id
    JOIN penguin_scans ps2 ON ps2.observation_id = ps1.observation_id AND ps2.pit_id != ps1.pit_id
    JOIN penguin_chips pc2 ON ps2.pit_id = pc2.pit_id
    JOIN penguins p2 ON pc2.peng_num = p2.peng_num
    WHERE pc1.peng_num = ? AND o.is_deleted = FALSE
    ORDER BY o.observation_time_utc DESC");
$stmt->execute([$pid]);
$partnerRows = $stmt->fetchAll();

$partners = [];
foreach ($partnerRows as $row) {
    $pnum = $row['partner_peng_num'];
    if (!isset($partners[$pnum])) {
        $partners[$pnum] = ['peng_num'=>$pnum, 'pit_id'=>$row['partner_pit_id'], 'sex'=>$row['partner_sex'],
            'life_stage'=>$row['partner_life_stage'], 'chipped_as_adult'=>$row['partner_chipped_as_adult'], 'chip_date'=>$row['partner_chip_date'], 'sightings'=>[]];
    }
    $partners[$pnum]['sightings'][] = ['box'=>$row['box_name'], 'date'=>$row['observation_time_utc'], 'monitor'=>$row['monitor_filename']];
}
usort($partners, function($a,$b){ return count($b['sightings'])-count($a['sightings']); });

// Breeding stats
$breedingStats = [];
foreach ($scans as $s) {
    $d = new DateTime($s['observation_time_utc']);
    $m = (int)$d->format('n');
    $y = (int)$d->format('Y');
    $seasonYear = $m >= 4 ? $y : $y - 1;
    $season = $seasonYear . '/' . substr($seasonYear + 1, -2);

    if (!isset($breedingStats[$season])) {
        $breedingStats[$season] = ['season'=>$season, 'scans'=>0, 'boxes'=>[], 'max_eggs'=>0, 'max_chicks'=>0, 'statuses'=>[]];
    }
    $bs = &$breedingStats[$season];
    $bs['scans']++;
    if (!in_array($s['box_name'], $bs['boxes'])) $bs['boxes'][] = $s['box_name'];
    if ((int)$s['eggs'] > $bs['max_eggs']) $bs['max_eggs'] = (int)$s['eggs'];
    if ((int)$s['chicks'] > $bs['max_chicks']) $bs['max_chicks'] = (int)$s['chicks'];
    if ($s['breeding_status'] && !in_array($s['breeding_status'], $bs['statuses'])) $bs['statuses'][] = $s['breeding_status'];
}
krsort($breedingStats);

echo json_encode([
    'penguin' => $penguin,
    'scans' => $scans,
    'biometrics' => $biometrics,
    'partners' => array_values($partners),
    'breeding_stats' => array_values($breedingStats),
]);
