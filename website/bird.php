<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();
$tag = $_GET['tag'] ?? '';
if (empty($tag)) { echo json_encode(['error'=>'tag required']); exit; }

// Look up by penguin_chips first, then fall back to tag_number
$stmt = $pdo->prepare("SELECT p.* FROM penguins p JOIN penguin_chips pc ON p.penguin_id = pc.penguin_id WHERE pc.chip_number = ? OR pc.chip_number LIKE ?");
$stmt->execute([$tag, '%'.$tag]);
$penguin = $stmt->fetch();
if (!$penguin) {
    $stmt = $pdo->prepare("SELECT * FROM penguins WHERE tag_number = ? OR tag_number LIKE ?");
    $stmt->execute([$tag, '%'.$tag]);
    $penguin = $stmt->fetch();
}
if (!$penguin) { echo json_encode(['error'=>'penguin not found']); exit; }
// Include chips in response
$chipsStmt = $pdo->prepare("SELECT chip_number, chip_date, is_active FROM penguin_chips WHERE penguin_id = ? ORDER BY chip_date");
$chipsStmt->execute([$penguin['penguin_id']]);
$penguin['chips'] = $chipsStmt->fetchAll();
$pid = $penguin['penguin_id'];

// All scans with observation context
$stmt = $pdo->prepare("SELECT ps.scan_time_utc, ps.latitude, ps.longitude, ps.accuracy,
    ol.location_name AS box_name, o.observation_time_utc, o.monitor_filename,
    o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes
    FROM penguin_scans ps
    JOIN observations o ON ps.observation_id = o.observation_id
    JOIN observation_locations ol ON o.location_id = ol.location_id
    WHERE ps.penguin_id = ? AND o.is_deleted = FALSE
    ORDER BY ps.scan_time_utc DESC");
$stmt->execute([$pid]);
$scans = $stmt->fetchAll();

// Biometrics
$stmt = $pdo->prepare("SELECT * FROM penguin_biometric_data WHERE penguin_id = ? ORDER BY observation_date DESC");
$stmt->execute([$pid]);
$biometrics = $stmt->fetchAll();

// Partners
$stmt = $pdo->prepare("SELECT p2.tag_number AS partner_tag, p2.sex AS partner_sex, p2.life_stage AS partner_life_stage,
    ol.location_name AS box_name, o.observation_time_utc, o.monitor_filename
    FROM penguin_scans ps1
    JOIN observations o ON ps1.observation_id = o.observation_id
    JOIN observation_locations ol ON o.location_id = ol.location_id
    JOIN penguin_scans ps2 ON ps2.observation_id = ps1.observation_id AND ps2.penguin_id != ps1.penguin_id
    JOIN penguins p2 ON ps2.penguin_id = p2.penguin_id
    WHERE ps1.penguin_id = ? AND o.is_deleted = FALSE
    ORDER BY o.observation_time_utc DESC");
$stmt->execute([$pid]);
$partnerRows = $stmt->fetchAll();

$partners = [];
foreach ($partnerRows as $row) {
    $ptag = substr($row['partner_tag'], -8);
    if (!isset($partners[$ptag])) {
        $partners[$ptag] = ['tag'=>$ptag, 'full_tag'=>$row['partner_tag'], 'sex'=>$row['partner_sex'],
            'life_stage'=>$row['partner_life_stage'], 'sightings'=>[]];
    }
    $partners[$ptag]['sightings'][] = ['box'=>$row['box_name'], 'date'=>$row['observation_time_utc'], 'monitor'=>$row['monitor_filename']];
}
usort($partners, function($a,$b){ return count($b['sightings'])-count($a['sightings']); });

// Breeding stats derived from observations where this bird was scanned
// Group by season (Apr 1 - Mar 31), count seasons with eggs, with chicks
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
