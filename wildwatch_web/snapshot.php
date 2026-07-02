<?php
/**
 * Full database snapshot for client-side caching.
 * Returns all tables needed for box/bird views in one response.
 *
 * GET /penguin-api/snapshot.php              - Full dump
 * GET /penguin-api/snapshot.php?since=<ISO>  - Incremental (rows changed since timestamp)
 */
ini_set('display_errors', 0);
set_exception_handler(function($e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage(), 'line' => $e->getLine()]);
    exit;
});
set_error_handler(function($errno, $errstr, $errfile, $errline) {
    throw new ErrorException($errstr, 0, $errno, $errfile, $errline);
});
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
$observer = requireAuth();

$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? 1);
requireColonyAccess($pdo, $observer, $colonyId);
$since = $_GET['since'] ?? null;

function getTotalCounts($pdo, $colonyId) {
    $c = function($sql, $params = []) use ($pdo) {
        $s = $pdo->prepare($sql); $s->execute($params); return (int)$s->fetchColumn();
    };
    return [
        'observations' => $c("SELECT COUNT(*) FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id WHERE ol.colony_id = ?", [$colonyId]),
        'scans' => $c("SELECT COUNT(*) FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id JOIN observation_locations ol ON o.location_id = ol.location_id WHERE ol.colony_id = ? AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)", [$colonyId]),
        'penguins' => $c("SELECT COUNT(*) FROM penguins"),
        'chips' => $c("SELECT COUNT(*) FROM penguin_chips"),
        'locations' => $c("SELECT COUNT(*) FROM observation_locations WHERE colony_id = ?", [$colonyId]),
        'biometrics' => $c("SELECT COUNT(*) FROM penguin_biometric_data"),
    ];
}

if ($since) {
    // Incremental sync: only rows updated since the given timestamp
    $ts = date('Y-m-d H:i:s', strtotime($since));

    $obs = $pdo->prepare("SELECT o.observation_id, o.location_id, o.observation_time_utc, o.monitor_filename, o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes, o.no_scan, o.is_deleted, o.updated_at
        FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND o.updated_at >= ?");
    $obs->execute([$colonyId, $ts]);

    // Scans: belonging to changed observations, or deleted since last sync
    $scans = $pdo->prepare("SELECT ps.scan_id, ps.observation_id, ps.pit_id, ps.is_deleted as scan_deleted
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND (o.updated_at >= ? OR ps.deleted_at >= ?)");
    $scans->execute([$colonyId, $ts, $ts]);

    $penguins = $pdo->prepare("SELECT peng_num, chipped_as_adult, sex, is_dead, vid_for_scanner, chick_size_code, kommentar FROM penguins WHERE updated_at >= ?");
    $penguins->execute([$ts]);

    // Chips: fetch any chip created/updated recently, or belonging to a recently changed penguin
    $chips = $pdo->prepare("SELECT pc.pit_id, pc.peng_num, pc.chip_date, pc.is_active, pc.chip_box, pc.location_id, pc.chip_by, pc.rechip_by, pc.solo
        FROM penguin_chips pc
        WHERE pc.created_at >= ?
           OR pc.peng_num IN (SELECT peng_num FROM penguins WHERE updated_at >= ?)");
    $chips->execute([$ts, $ts]);

    $locations = $pdo->prepare("SELECT location_id, location_name, persistent_notes, pit_id, latitude, longitude, accuracy FROM observation_locations WHERE colony_id = ? AND updated_at >= ?");
    $locations->execute([$colonyId, $ts]);

    $bio = $pdo->prepare("SELECT biometric_id, peng_num, observation_id, observation_date, observed_sex, weight, right_flipper_length, condition_ticks, notes, is_moulting, disposition_aggressive, disposition_passive FROM penguin_biometric_data WHERE biometric_id IN (SELECT DISTINCT record_id FROM audit_log WHERE table_name = 'penguin_biometric_data' AND change_timestamp >= ?)");
    $bio->execute([$ts]);

    $obsRows = $obs->fetchAll();
    $changedObsIds = array_column($obsRows, 'observation_id');
    $editCounts = [];
    if (!empty($changedObsIds)) {
        $ph = implode(',', array_fill(0, count($changedObsIds), '?'));
        $ec = $pdo->prepare("SELECT record_id, COUNT(*) as c FROM audit_log WHERE table_name = 'observations' AND action = 'UPDATE' AND record_id IN ($ph) GROUP BY record_id");
        $ec->execute(array_values($changedObsIds));
        foreach ($ec->fetchAll() as $row) $editCounts[(int)$row['record_id']] = (int)$row['c'];
    }

    // Use the current max watermark as snapshot_time (not server clock)
    // This ensures we never skip data due to timing gaps
    $wmStmt = $pdo->query("SELECT GREATEST(
        COALESCE((SELECT MAX(updated_at) FROM observations), '2000-01-01'),
        COALESCE((SELECT MAX(updated_at) FROM penguins), '2000-01-01'),
        COALESCE((SELECT MAX(updated_at) FROM observation_locations), '2000-01-01'),
        COALESCE((SELECT MAX(deleted_at) FROM penguin_scans), '2000-01-01'),
        COALESCE((SELECT MAX(created_at) FROM penguin_chips), '2000-01-01')
    ) as wm");
    $snapshotTime = $wmStmt->fetch()['wm'];

    $pengRows = $penguins->fetchAll(); stripPengPrefix($pengRows);
    $chipRows = $chips->fetchAll(); stripPengPrefix($chipRows);
    $bioRows = $bio->fetchAll(); stripPengPrefix($bioRows);
    echo json_encode([
        'incremental' => true,
        'since' => $ts,
        'snapshot_time' => $snapshotTime,
        'observations' => $obsRows,
        'scans' => $scans->fetchAll(),
        'penguins' => $pengRows,
        'chips' => $chipRows,
        'locations' => $locations->fetchAll(),
        'biometrics' => $bioRows,
        'edit_counts' => $editCounts,
        '_counts' => getTotalCounts($pdo, $colonyId),
    ]);
    exit;
}

// Full snapshot
$t0 = microtime(true);

$obs = $pdo->prepare("SELECT o.observation_id, o.location_id, o.observation_time_utc, o.monitor_filename, o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes, o.no_scan, o.is_deleted
    FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
    WHERE ol.colony_id = ?");
$obs->execute([$colonyId]);
$observations = $obs->fetchAll();

// Edit counts in one query
$ec = $pdo->query("SELECT record_id, COUNT(*) as c FROM audit_log WHERE table_name = 'observations' AND action = 'UPDATE' GROUP BY record_id");
$editCounts = [];
foreach ($ec->fetchAll() as $row) $editCounts[(int)$row['record_id']] = (int)$row['c'];

$scans = $pdo->prepare("SELECT ps.scan_id, ps.observation_id, ps.pit_id, ps.is_deleted as scan_deleted
    FROM penguin_scans ps
    JOIN observations o ON ps.observation_id = o.observation_id
    JOIN observation_locations ol ON o.location_id = ol.location_id
    WHERE ol.colony_id = ? AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)");
$scans->execute([$colonyId]);

$penguins = $pdo->query("SELECT peng_num, chipped_as_adult, sex, is_dead, vid_for_scanner, chick_size_code, kommentar FROM penguins");

$chips = $pdo->query("SELECT pit_id, peng_num, chip_date, is_active, chip_box, location_id, chip_by, rechip_by, solo FROM penguin_chips");

$locations = $pdo->prepare("SELECT location_id, location_name, persistent_notes, pit_id, latitude, longitude, accuracy FROM observation_locations WHERE colony_id = ?");
$locations->execute([$colonyId]);

$bio = $pdo->query("SELECT biometric_id, peng_num, observation_id, observation_date, observed_sex, weight, right_flipper_length, condition_ticks, notes, is_moulting, disposition_aggressive, disposition_passive FROM penguin_biometric_data");

$elapsed = round((microtime(true) - $t0) * 1000);

$fullWm = $pdo->query("SELECT GREATEST(
    COALESCE((SELECT MAX(updated_at) FROM observations), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM penguins), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM observation_locations), '2000-01-01'),
    COALESCE((SELECT MAX(deleted_at) FROM penguin_scans), '2000-01-01'),
    COALESCE((SELECT MAX(created_at) FROM penguin_chips), '2000-01-01'),
    COALESCE((SELECT MAX(change_timestamp) FROM audit_log), '2000-01-01')
) as wm")->fetch()['wm'];

$pengRows = $penguins->fetchAll(); stripPengPrefix($pengRows);
$chipRows = $chips->fetchAll(); stripPengPrefix($chipRows);
$bioRows = $bio->fetchAll(); stripPengPrefix($bioRows);
$json = json_encode([
    'incremental' => false,
    'snapshot_time' => $fullWm,
    'query_ms' => $elapsed,
    'observations' => $observations,
    'scans' => $scans->fetchAll(),
    'penguins' => $pengRows,
    'chips' => $chipRows,
    'locations' => $locations->fetchAll(),
    'biometrics' => $bioRows,
    'edit_counts' => $editCounts,
    '_counts' => getTotalCounts($pdo, $colonyId),
]);

// Manual gzip with known Content-Length for accurate client progress
$gz = gzencode($json, 6);
header('Content-Encoding: identity'); // prevent double-gzip by server
header('Content-Type: application/gzip');
header('Content-Length: ' . strlen($gz));
header('X-Uncompressed-Length: ' . strlen($json));
echo $gz;
