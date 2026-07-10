<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key');
header('Cache-Control: no-cache');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
$auth = requireReadAuth();

$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? 1);
$viewPrefix = getColonyPrefix($pdo, $colonyId);

// All penguins across every colony the caller may view — the "All penguins" page.
// Newest initial chip first. peng_nums stay fully prefixed: the list spans colonies,
// so a bare number would be ambiguous.
if (isset($_GET['all'])) {
    $where = '';
    $args = [];
    if (is_array($auth) && ($auth['role'] ?? '') !== 'admin') {
        $ids = $pdo->prepare("SELECT colony_id FROM colony_permissions WHERE observer_id = ?");
        $ids->execute([$auth['observer_id']]);
        $colonyIds = $ids->fetchAll(PDO::FETCH_COLUMN);
        if (empty($colonyIds)) { echo json_encode([]); exit; }
        $where = 'WHERE p.colony_id IN (' . implode(',', array_fill(0, count($colonyIds), '?')) . ')';
        $args = $colonyIds;
    }
    $stmt = $pdo->prepare("SELECT p.peng_num, p.sex, p.is_dead, p.death_date, p.chipped_as_adult, p.chick_size_code, c.colony_name
        FROM penguins p
        JOIN colonies c ON c.colony_id = p.colony_id
        $where");
    $stmt->execute($args);
    $birds = [];
    foreach ($stmt->fetchAll() as $b) $birds[$b['peng_num']] = $b;

    // Initial-chip info comes from the earliest chip; the pits list carries every chip a
    // rechipped bird has worn (chip-date order), each flagged active/inactive.
    foreach ($pdo->query("SELECT peng_num, pit_id, chip_date, chip_box, chip_by, is_active
                          FROM penguin_chips ORDER BY chip_date, pit_id") as $ch) {
        if (!isset($birds[$ch['peng_num']])) continue;
        $b = &$birds[$ch['peng_num']];
        if (!isset($b['first_chip_date'])) {
            $b['first_chip_date'] = $ch['chip_date'];
            $b['first_chip_box'] = $ch['chip_box'];
            $b['first_chip_by'] = $ch['chip_by'];
        }
        $b['pits'][] = ['pit_id' => $ch['pit_id'], 'is_active' => (int)$ch['is_active']];
        unset($b);
    }

    // Chip-day biometric (weight/flipper), matching what the bird panel's chip line shows,
    // plus observed-sex guess tallies (PM/MM vs PF/MF, same rule as the app's observedSexGuess)
    // so unconfirmed birds can display UM/UF.
    foreach ($pdo->query("SELECT peng_num, observation_date, weight, flipper_length, observed_sex
                          FROM penguin_biometric_data
                          WHERE (is_deleted = FALSE OR is_deleted IS NULL)") as $bio) {
        if (!isset($birds[$bio['peng_num']])) continue;
        $b = &$birds[$bio['peng_num']];
        $s = strtoupper((string)($bio['observed_sex'] ?? ''));
        if (in_array($s, ['PM', 'MM', 'M'], true)) $b['guess_m'] = ($b['guess_m'] ?? 0) + 1;
        elseif (in_array($s, ['PF', 'MF', 'F'], true)) $b['guess_f'] = ($b['guess_f'] ?? 0) + 1;
        if (isset($b['first_chip_date'])
            && substr($bio['observation_date'], 0, 10) === substr($b['first_chip_date'], 0, 10)) {
            if ($bio['weight'] !== null && !isset($b['chip_weight'])) $b['chip_weight'] = $bio['weight'];
            if ($bio['flipper_length'] !== null && !isset($b['chip_flipper'])) $b['chip_flipper'] = $bio['flipper_length'];
        }
        unset($b);
    }

    $birds = array_values($birds);
    usort($birds, fn($a, $b2) => strcmp($b2['first_chip_date'] ?? '', $a['first_chip_date'] ?? '')
        ?: strcmp($b2['peng_num'], $a['peng_num']));
    echo json_encode($birds);
    exit;
}

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
        $penguin['chips'] = getChips($pdo, $penguin['peng_num']); // full peng_num for the FK lookup
        $penguin['peng_num'] = displayPengNum($penguin['peng_num'], $viewPrefix);
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
            p.peng_num, p.sex, p.is_dead, p.chipped_as_adult, p.vid_for_scanner, p.chick_size_code,
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
stripPengPrefix($penguins, $viewPrefix);

echo json_encode($penguins);

function getChips($pdo, $pengNum) {
    $stmt = $pdo->prepare("SELECT pit_id, chip_date, is_active FROM penguin_chips WHERE peng_num = ? ORDER BY chip_date");
    $stmt->execute([$pengNum]);
    return $stmt->fetchAll();
}
