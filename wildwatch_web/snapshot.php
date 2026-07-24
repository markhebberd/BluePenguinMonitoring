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
require_once 'snapshot_columns.php';
header('Content-Type: application/json');
header('Cache-Control: no-cache');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
$observer = requireAuth();

$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? 1);
requireColonyAccess($pdo, $observer, $colonyId);
$since = $_GET['since'] ?? null;

// Per-colony Full Monitor exclusion list — sent on every snapshot (full + incremental)
// so an admin edit propagates to clients on their next poll without a full re-sync.
$fmStmt = $pdo->prepare("SELECT fm_excluded_boxes FROM colonies WHERE colony_id = ?");
$fmStmt->execute([$colonyId]);
$fmExcludedBoxes = $fmStmt->fetchColumn();
if ($fmExcludedBoxes === false) $fmExcludedBoxes = '0,AA,AB,AC';

/** Human-verified breeding truth for the colony — verifications, their chick rows, and
 *  disagreements. Tiny (≤ one verification per verified clutch), so it's fetched in FULL on
 *  every snapshot (full and incremental): the client replaces its three stores wholesale,
 *  which handles deletes without a full reload. peng_num columns are prefix-stripped to match
 *  the stripped penguins/chips the client already holds. */
function getVerificationData($pdo, $colonyId, $viewPrefix) {
    $ver = $pdo->prepare("SELECT " . SNAP_COLS_VER . " FROM breeding_verifications v
        JOIN observations o ON o.observation_id = v.observation_id
        JOIN observation_locations ol ON ol.location_id = o.location_id
        LEFT JOIN observers oa ON oa.observer_id = v.adults_verified_by
        LEFT JOIN observers oc ON oc.observer_id = v.chicks_verified_by
        WHERE ol.colony_id = ?");
    $ver->execute([$colonyId]);
    $verRows = $ver->fetchAll();
    stripPengPrefix($verRows, $viewPrefix, 'male_peng_num');
    stripPengPrefix($verRows, $viewPrefix, 'female_peng_num');

    $chick = $pdo->prepare("SELECT " . SNAP_COLS_VER_CHICK . " FROM breeding_verification_chicks vc
        JOIN breeding_verifications v ON v.verification_id = vc.verification_id
        JOIN observations o ON o.observation_id = v.observation_id
        JOIN observation_locations ol ON ol.location_id = o.location_id
        WHERE ol.colony_id = ?");
    $chick->execute([$colonyId]);
    $chickRows = $chick->fetchAll();
    stripPengPrefix($chickRows, $viewPrefix);

    $dis = $pdo->prepare("SELECT " . SNAP_COLS_DISAG . " FROM breeding_verification_disagreements d
        JOIN observations o ON o.observation_id = d.observation_id
        JOIN observation_locations ol ON ol.location_id = o.location_id
        LEFT JOIN observers ob ON ob.observer_id = d.raised_by
        WHERE ol.colony_id = ?");
    $dis->execute([$colonyId]);

    return ['verifications' => $verRows, 'verification_chicks' => $chickRows, 'disagreements' => $dis->fetchAll()];
}

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

    $obs = $pdo->prepare("SELECT o.observation_id, o.location_id, o.observation_time_utc, o.monitor_filename, o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes, o.no_scan, o.fledged_unchipped, o.is_deleted, o.updated_at
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

    $penguins = $pdo->prepare("SELECT peng_num, chipped_as_adult, sex, is_dead, death_date, vid_for_scanner, chick_size_code, notes FROM penguins WHERE updated_at >= ?");
    $penguins->execute([$ts]);

    // Chips: fetch any chip created/updated recently, or belonging to a recently changed penguin
    $chips = $pdo->prepare("SELECT pc.pit_id, pc.peng_num, pc.chip_date, pc.is_active, pc.chip_box, pc.location_id, pc.chip_by, pc.solo
        FROM penguin_chips pc
        WHERE pc.created_at >= ?
           OR pc.peng_num IN (SELECT peng_num FROM penguins WHERE updated_at >= ?)");
    $chips->execute([$ts, $ts]);

    $locations = $pdo->prepare("SELECT " . SNAP_COLS_LOC . " FROM observation_locations WHERE colony_id = ? AND updated_at >= ?");
    $locations->execute([$colonyId, $ts]);

    $bio = $pdo->prepare("SELECT biometric_id, peng_num, observation_id, observation_date, sex, observed_sex, weight, flipper_length, body_length, beak_length, condition_healthy, condition_ticks, is_moulting, disposition_aggressive, disposition_passive, notes, is_deleted FROM penguin_biometric_data WHERE biometric_id IN (SELECT DISTINCT record_id FROM audit_log WHERE table_name = 'penguin_biometric_data' AND change_timestamp >= ?)");
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
        COALESCE((SELECT MAX(created_at) FROM penguin_chips), '2000-01-01'),
        COALESCE((SELECT MAX(updated_at) FROM breeding_verifications), '2000-01-01'),
        COALESCE((SELECT MAX(raised_at) FROM breeding_verification_disagreements), '2000-01-01')
    ) as wm");
    $snapshotTime = $wmStmt->fetch()['wm'];

    $viewPrefix = getColonyPrefix($pdo, $colonyId);
    $pengRows = $penguins->fetchAll(); stripPengPrefix($pengRows, $viewPrefix);
    $chipRows = $chips->fetchAll(); stripPengPrefix($chipRows, $viewPrefix);
    $bioRows = $bio->fetchAll(); stripPengPrefix($bioRows, $viewPrefix);
    echo json_encode(array_merge([
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
        'fm_excluded_boxes' => $fmExcludedBoxes,
        '_counts' => getTotalCounts($pdo, $colonyId),
    ], getVerificationData($pdo, $colonyId, $viewPrefix)));
    exit;
}

// Full snapshot
$t0 = microtime(true);

$obs = $pdo->prepare("SELECT " . SNAP_COLS_OBS . "
    FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
    WHERE ol.colony_id = ?");
$obs->execute([$colonyId]);
$observations = $obs->fetchAll();

// Edit counts in one query
$ec = $pdo->query("SELECT record_id, COUNT(*) as c FROM audit_log WHERE table_name = 'observations' AND action = 'UPDATE' GROUP BY record_id");
$editCounts = [];
foreach ($ec->fetchAll() as $row) $editCounts[(int)$row['record_id']] = (int)$row['c'];

$scans = $pdo->prepare("SELECT " . SNAP_COLS_SCAN . "
    FROM penguin_scans ps
    JOIN observations o ON ps.observation_id = o.observation_id
    JOIN observation_locations ol ON o.location_id = ol.location_id
    WHERE ol.colony_id = ? AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)");
$scans->execute([$colonyId]);

$penguins = $pdo->query("SELECT " . SNAP_COLS_PENG . " FROM penguins");

$chips = $pdo->query("SELECT " . SNAP_COLS_CHIP . " FROM penguin_chips");

$locations = $pdo->prepare("SELECT " . SNAP_COLS_LOC . " FROM observation_locations WHERE colony_id = ?");
$locations->execute([$colonyId]);

$bio = $pdo->query("SELECT " . SNAP_COLS_BIO . " FROM penguin_biometric_data");

$elapsed = round((microtime(true) - $t0) * 1000);

$fullWm = $pdo->query("SELECT GREATEST(
    COALESCE((SELECT MAX(updated_at) FROM observations), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM penguins), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM observation_locations), '2000-01-01'),
    COALESCE((SELECT MAX(deleted_at) FROM penguin_scans), '2000-01-01'),
    COALESCE((SELECT MAX(created_at) FROM penguin_chips), '2000-01-01'),
    COALESCE((SELECT MAX(change_timestamp) FROM audit_log), '2000-01-01')
) as wm")->fetch()['wm'];

$viewPrefix = getColonyPrefix($pdo, $colonyId);
$pengRows = $penguins->fetchAll(); stripPengPrefix($pengRows, $viewPrefix);
$chipRows = $chips->fetchAll(); stripPengPrefix($chipRows, $viewPrefix);
$bioRows = $bio->fetchAll(); stripPengPrefix($bioRows, $viewPrefix);
$json = json_encode(array_merge([
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
    'fm_excluded_boxes' => $fmExcludedBoxes,
    '_counts' => getTotalCounts($pdo, $colonyId),
], getVerificationData($pdo, $colonyId, $viewPrefix)));

// Manual gzip with known Content-Length for accurate client progress
$gz = gzencode($json, 6);
header('Content-Encoding: identity'); // prevent double-gzip by server
header('Content-Type: application/gzip');
header('Content-Length: ' . strlen($gz));
header('X-Uncompressed-Length: ' . strlen($json));
echo $gz;
