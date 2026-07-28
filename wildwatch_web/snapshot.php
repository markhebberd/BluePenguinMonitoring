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
/** Who is asking, as the phone needs to see itself: nestcheck keeps the signing acronym and permit
 *  id it stamps chippings with in step with the server, and this is the only place the caller is
 *  identified. Name only — no email, no hash. */
function wwSnapshotMe($observer): array {
    return [
        'observer_id' => (int)($observer['observer_id'] ?? $observer['id'] ?? 0),
        'name' => $observer['observer_name'] ?? $observer['f_name'] ?? null,
        'chip_acronym' => $observer['chip_acronym'] ?? null,
        'falcon_id' => $observer['falcon_id'] ?? null,
    ];
}

$observer = requireAuth();

$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? 1);
requireColonyAccess($pdo, $observer, $colonyId);
$since = $_GET['since'] ?? null;

// Nestcheck asks for scope=field. It is a field app: it shows the box in front of you today and
// what was in it last time, so it needs today's observations plus each nest's most recent OTHER
// visit — around three hundred rows, against the colony's ~45k of history, which it has no screen
// for and no reason to carry. The website's cache omits the parameter and still gets everything.
$fieldScope = ($_GET['scope'] ?? '') === 'field';

/**
 * The field set: every observation from today, plus the newest earlier one per box. Returned as
 * ids, so both the full and the incremental branch can restrict to exactly the same rows.
 *
 * A quiet box last looked at eight months ago still has to show its previous visit, which is why
 * this is a per-box tail rather than a date window — a window would leave those boxes blank.
 */
function wwFieldScopeIds($pdo, $colonyId): array {
    $nzToday = (new DateTime('now', new DateTimeZone('Pacific/Auckland')))->format('Y-m-d');
    $ids = [];
    $today = $pdo->prepare("SELECT o.observation_id FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND o.is_deleted = FALSE
        AND DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) = ?");
    $today->execute([$colonyId, $nzToday]);
    foreach ($today->fetchAll(PDO::FETCH_COLUMN) as $id) $ids[] = (int)$id;

    $prev = $pdo->prepare("SELECT o.observation_id FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND o.is_deleted = FALSE
        AND o.observation_id = (SELECT o2.observation_id FROM observations o2
            WHERE o2.location_id = o.location_id AND o2.is_deleted = FALSE
              AND DATE(CONVERT_TZ(o2.observation_time_utc, '+00:00', '+12:00')) < ?
            ORDER BY o2.observation_time_utc DESC LIMIT 1)");
    $prev->execute([$colonyId, $nzToday]);
    foreach ($prev->fetchAll(PDO::FETCH_COLUMN) as $id) $ids[] = (int)$id;

    return array_values(array_unique($ids));
}

// Per-colony Full Monitor exclusion list — sent on every snapshot (full + incremental)
// so an admin edit propagates to clients on their next poll without a full re-sync.
$fmStmt = $pdo->prepare("SELECT fm_excluded_boxes FROM colonies WHERE colony_id = ?");
$fmStmt->execute([$colonyId]);
$fmExcludedBoxes = $fmStmt->fetchColumn();
if ($fmExcludedBoxes === false) $fmExcludedBoxes = '0,AA,AB,AC';

/** Human-verified breeding truth for the colony — one row per verified clutch. Tiny, so it's
 *  fetched in FULL on every snapshot (full and incremental): the client replaces its store
 *  wholesale, which handles deletes without a full reload. peng_num columns (and each element of
 *  the chicks JSON array) are prefix-stripped to match the stripped penguins the client holds. */
function getVerificationData($pdo, $colonyId, $viewPrefix) {
    $ver = $pdo->prepare("SELECT " . SNAP_COLS_VER . " FROM breeding_verifications v
        JOIN observations o ON o.observation_id = v.observation_id
        JOIN observation_locations ol ON ol.location_id = o.location_id
        LEFT JOIN users oa ON oa.id = v.adults_reviewed_by
        LEFT JOIN users oc ON oc.id = v.chicks_reviewed_by
        WHERE ol.colony_id = ?");
    $ver->execute([$colonyId]);
    $verRows = $ver->fetchAll();
    stripPengPrefix($verRows, $viewPrefix, 'male_peng_num');
    stripPengPrefix($verRows, $viewPrefix, 'female_peng_num');
    foreach ($verRows as &$vr) {
        $arr = json_decode($vr['chicks'] ?? 'null', true);
        $vr['chicks'] = is_array($arr) ? array_map(fn($pn) => displayPengNum((string)$pn, $viewPrefix), $arr) : [];
    }
    unset($vr);
    return ['verifications' => $verRows];
}

/** The colony's day notes — one free-text line per NZ date. A few hundred rows at most, so
 *  they ride every snapshot (full and incremental) in FULL: the client replaces its store
 *  wholesale, which is how a cleared note leaves the cache. */
function getDayNotes($pdo, $colonyId) {
    $dn = $pdo->prepare("SELECT " . SNAP_COLS_DAYNOTE . " FROM day_notes d WHERE d.colony_id = ? ORDER BY d.note_date");
    $dn->execute([$colonyId]);
    return ['day_notes' => $dn->fetchAll()];
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

if ($fieldScope) {
    // The field set is small enough to send whole every time, and sending it whole is what makes
    // it correct: an insert, an edit and a delete are all just "what the set contains now", with
    // no tombstone to carry and no way for the phone to drift out of step. The big tables still
    // come with it — birds and chips are what the scanner reads, and they are ~2k rows.
    $ids = wwFieldScopeIds($pdo, $colonyId);
    $ph = $ids ? implode(',', array_fill(0, count($ids), '?')) : 'NULL';

    $obs = $pdo->prepare("SELECT " . SNAP_COLS_OBS . " FROM observations o WHERE o.observation_id IN ($ph)");
    $obs->execute($ids);
    $scans = $pdo->prepare("SELECT " . SNAP_COLS_SCAN . " FROM penguin_scans ps
        WHERE ps.observation_id IN ($ph) AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)");
    $scans->execute($ids);

    // Bird details for the visits on screen, plus anything recorded today — the detail form opens
    // on today's record, and the previous visit's readings are what it is compared against.
    $nzToday = (new DateTime('now', new DateTimeZone('Pacific/Auckland')))->format('Y-m-d');
    $bio = $pdo->prepare("SELECT " . SNAP_COLS_BIO . " FROM penguin_biometric_data
        WHERE (is_deleted = FALSE OR is_deleted IS NULL)
          AND (observation_date = ? OR observation_id IN ($ph))");
    $bio->execute(array_merge([$nzToday], $ids));

    $penguins = $pdo->query("SELECT " . SNAP_COLS_PENG . " FROM penguins");
    $chips = $pdo->query("SELECT " . SNAP_COLS_CHIP . " FROM penguin_chips");
    $locations = $pdo->prepare("SELECT " . SNAP_COLS_LOC . " FROM observation_locations WHERE colony_id = ?");
    $locations->execute([$colonyId]);

    $viewPrefix = getColonyPrefix($pdo, $colonyId);
    $pengRows = $penguins->fetchAll(); stripPengPrefix($pengRows, $viewPrefix);
    $chipRows = $chips->fetchAll(); stripPengPrefix($chipRows, $viewPrefix);
    $bioRows = $bio->fetchAll(); stripPengPrefix($bioRows, $viewPrefix);

    echo json_encode(array_merge([
        'incremental' => false,
        'scope' => 'field',
        'me' => wwSnapshotMe($observer),
        'snapshot_time' => $pdo->query("SELECT GREATEST(
            COALESCE((SELECT MAX(updated_at) FROM observations), '2000-01-01'),
            COALESCE((SELECT MAX(updated_at) FROM penguins), '2000-01-01'),
            COALESCE((SELECT MAX(updated_at) FROM observation_locations), '2000-01-01'),
            COALESCE((SELECT MAX(change_timestamp) FROM audit_log), '2000-01-01')
        ) as wm")->fetch()['wm'],
        'observations' => $obs->fetchAll(),
        'scans' => $scans->fetchAll(),
        'penguins' => $pengRows,
        'chips' => $chipRows,
        'locations' => $locations->fetchAll(),
        'biometrics' => $bioRows,
        'fm_excluded_boxes' => $fmExcludedBoxes,
    ], getDayNotes($pdo, $colonyId), getObservers($pdo)));
    exit;
}

if ($since) {
    // Incremental sync: only rows updated since the given timestamp
    $ts = date('Y-m-d H:i:s', strtotime($since));

    $obs = $pdo->prepare("SELECT " . SNAP_COLS_OBS . ", o.updated_at
        FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND o.updated_at >= ?");
    $obs->execute([$colonyId, $ts]);

    // Scans: belonging to changed observations, or deleted since last sync
    $scans = $pdo->prepare("SELECT " . SNAP_COLS_SCAN . "
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND (o.updated_at >= ? OR ps.deleted_at >= ?)");
    $scans->execute([$colonyId, $ts, $ts]);

    $penguins = $pdo->prepare("SELECT " . SNAP_COLS_PENG . " FROM penguins WHERE updated_at >= ?");
    $penguins->execute([$ts]);

    // Chips: fetch any chip created/updated recently, or belonging to a recently changed penguin
    $chips = $pdo->prepare("SELECT " . SNAP_COLS_CHIP_P . "
        FROM penguin_chips pc
        WHERE pc.created_at >= ?
           OR pc.peng_num IN (SELECT peng_num FROM penguins WHERE updated_at >= ?)");
    $chips->execute([$ts, $ts]);

    $locations = $pdo->prepare("SELECT " . SNAP_COLS_LOC . " FROM observation_locations WHERE colony_id = ? AND updated_at >= ?");
    $locations->execute([$colonyId, $ts]);

    $bio = $pdo->prepare("SELECT " . SNAP_COLS_BIO . " FROM penguin_biometric_data WHERE biometric_id IN (SELECT DISTINCT record_id FROM audit_log WHERE table_name = 'penguin_biometric_data' AND change_timestamp >= ?)");
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
        COALESCE((SELECT MAX(updated_at) FROM day_notes), '2000-01-01')
    ) as wm");
    $snapshotTime = $wmStmt->fetch()['wm'];

    $viewPrefix = getColonyPrefix($pdo, $colonyId);
    $pengRows = $penguins->fetchAll(); stripPengPrefix($pengRows, $viewPrefix);
    $chipRows = $chips->fetchAll(); stripPengPrefix($chipRows, $viewPrefix);
    $bioRows = $bio->fetchAll(); stripPengPrefix($bioRows, $viewPrefix);
    echo json_encode(array_merge([
        'incremental' => true,
        'me' => wwSnapshotMe($observer),
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
    ], getVerificationData($pdo, $colonyId, $viewPrefix), getDayNotes($pdo, $colonyId), getObservers($pdo)));
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
    'me' => wwSnapshotMe($observer),
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
], getVerificationData($pdo, $colonyId, $viewPrefix), getDayNotes($pdo, $colonyId), getObservers($pdo)));

// Manual gzip with known Content-Length for accurate client progress
$gz = gzencode($json, 6);
header('Content-Encoding: identity'); // prevent double-gzip by server
header('Content-Type: application/gzip');
header('Content-Length: ' . strlen($gz));
header('X-Uncompressed-Length: ' . strlen($json));
echo $gz;
