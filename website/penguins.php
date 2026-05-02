<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();

$chipId = $_GET['chip_id'] ?? null;

if ($chipId) {
    // Lookup by chip number (checks penguin_chips first, falls back to tag_number)
    $chipId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $chipId));
    $stmt = $pdo->prepare("SELECT p.* FROM penguins p JOIN penguin_chips pc ON p.penguin_id = pc.penguin_id WHERE pc.chip_number = ?");
    $stmt->execute([$chipId]);
    $penguin = $stmt->fetch();

    if (!$penguin) {
        $stmt = $pdo->prepare("SELECT * FROM penguins WHERE tag_number = ? OR tag_number LIKE ?");
        $stmt->execute([$chipId, '%'.$chipId]);
        $penguin = $stmt->fetch();
    }

    if ($penguin) {
        $penguin['chips'] = getChips($pdo, $penguin['penguin_id']);
        echo json_encode($penguin);
    } else {
        http_response_code(404);
        echo json_encode(['error' => 'Penguin not found']);
    }
    exit;
}

// Return all penguins with summary stats
$sql = "SELECT
            p.penguin_id, p.penguin_number, p.tag_number, p.sex, p.life_stage,
            p.chip_date, p.initial_chip_date, p.chipped_as_adult, p.vid_for_scanner,
            COUNT(DISTINCT ps.observation_id) as total_scans,
            COUNT(DISTINCT ol.location_name) as boxes_seen,
            MAX(o.observation_time_utc) as last_seen,
            (SELECT COUNT(DISTINCT ps2.penguin_id)
             FROM penguin_scans ps2
             JOIN penguin_scans ps3 ON ps2.observation_id = ps3.observation_id AND ps2.penguin_id != ps3.penguin_id
             WHERE ps3.penguin_id = p.penguin_id) as partner_count,
            (SELECT SUM(o2.chicks)
             FROM penguin_scans ps4
             JOIN observations o2 ON ps4.observation_id = o2.observation_id
             WHERE ps4.penguin_id = p.penguin_id AND o2.chicks > 0 AND o2.is_deleted = FALSE) as total_chicks_raised
        FROM penguins p
        LEFT JOIN penguin_scans ps ON ps.penguin_id = p.penguin_id
        LEFT JOIN observations o ON ps.observation_id = o.observation_id AND o.is_deleted = FALSE
        LEFT JOIN observation_locations ol ON o.location_id = ol.location_id
        GROUP BY p.penguin_id
        HAVING total_scans > 0
        ORDER BY last_seen DESC";

$stmt = $pdo->query($sql);
$penguins = $stmt->fetchAll();

echo json_encode($penguins);

function getChips($pdo, $penguinId) {
    $stmt = $pdo->prepare("SELECT chip_number, chip_date, is_active FROM penguin_chips WHERE penguin_id = ? ORDER BY chip_date");
    $stmt->execute([$penguinId]);
    return $stmt->fetchAll();
}
