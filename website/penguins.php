<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();

// Count-only endpoint for validation
if (isset($_GET['count'])) {
    $stmt = $pdo->query("SELECT COUNT(*) as c FROM penguins p JOIN penguin_chips pc ON p.peng_num = pc.peng_num AND pc.is_active = 1");
    echo json_encode(['count' => (int)$stmt->fetch()['c']]);
    exit;
}

$chipId = $_GET['chip_id'] ?? null;

if ($chipId) {
    $chipId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $chipId));
    $stmt = $pdo->prepare("SELECT p.* FROM penguins p JOIN penguin_chips pc ON p.peng_num = pc.peng_num WHERE pc.pit_id = ? OR pc.pit_id LIKE ?");
    $stmt->execute([$chipId, '%'.$chipId]);
    $penguin = $stmt->fetch();

    if ($penguin) {
        $penguin['chips'] = getChips($pdo, $penguin['peng_num']);
        echo json_encode($penguin);
    } else {
        http_response_code(404);
        echo json_encode(['error' => 'Penguin not found']);
    }
    exit;
}

// Return all penguins with summary stats
// JOIN through penguin_chips to get pit_id and chip_date
$sql = "SELECT
            p.peng_num, p.sex, p.life_stage, p.chipped_as_adult, p.vid_for_scanner, p.chick_size_code,
            pc_active.pit_id, pc_active.chip_date,
            COUNT(DISTINCT ps.observation_id) as total_scans,
            COUNT(DISTINCT ol.location_name) as boxes_seen,
            MAX(o.observation_time_utc) as last_seen,
            (SELECT COUNT(DISTINCT pc3.peng_num)
             FROM penguin_scans ps2
             JOIN penguin_chips pc2 ON ps2.pit_id = pc2.pit_id
             JOIN penguin_scans ps3 ON ps2.observation_id = ps3.observation_id AND ps2.pit_id != ps3.pit_id
             JOIN penguin_chips pc3 ON ps3.pit_id = pc3.pit_id
             WHERE pc2.peng_num = p.peng_num) as partner_count,
            (SELECT MAX(o2.chicks)
             FROM penguin_scans ps4
             JOIN penguin_chips pc4 ON ps4.pit_id = pc4.pit_id
             JOIN observations o2 ON ps4.observation_id = o2.observation_id
             WHERE pc4.peng_num = p.peng_num AND o2.chicks > 0 AND o2.is_deleted = FALSE) as max_chicks
        FROM penguins p
        LEFT JOIN penguin_chips pc_active ON pc_active.peng_num = p.peng_num AND pc_active.is_active = 1
        LEFT JOIN penguin_chips pc_any ON pc_any.peng_num = p.peng_num
        LEFT JOIN penguin_scans ps ON ps.pit_id = pc_any.pit_id
        LEFT JOIN observations o ON ps.observation_id = o.observation_id AND o.is_deleted = FALSE
        LEFT JOIN observation_locations ol ON o.location_id = ol.location_id
        GROUP BY p.peng_num
        ORDER BY last_seen DESC, p.peng_num + 0 ASC";

$stmt = $pdo->query($sql);
$penguins = $stmt->fetchAll();

echo json_encode($penguins);

function getChips($pdo, $pengNum) {
    $stmt = $pdo->prepare("SELECT pit_id, chip_date, is_active FROM penguin_chips WHERE peng_num = ? ORDER BY chip_date");
    $stmt->execute([$pengNum]);
    return $stmt->fetchAll();
}
