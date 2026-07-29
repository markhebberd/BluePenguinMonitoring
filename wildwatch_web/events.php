<?php
/**
 * Lightweight change detection endpoint.
 * Returns current data watermark for client-side polling.
 *
 * GET /penguin-api/events.php?wm=<last_watermark>
 *   → {"changed": true/false, "wm": "2026-05-20 09:15:49"}
 */
require_once 'config.php';
header('Content-Type: application/json');
header('Cache-Control: no-cache');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
requireAuth();

$pdo = getDbConnection();
// colonies.updated_at added for change tracking (one-time migration already applied)
$stmt = $pdo->query("SELECT GREATEST(
    COALESCE((SELECT MAX(updated_at) FROM observations), '2000-01-01'),
    COALESCE((SELECT MAX(deleted_at) FROM observations), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM penguins), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM observation_locations), '2000-01-01'),
    COALESCE((SELECT MAX(deleted_at) FROM penguin_scans), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM colonies), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM breeding_verifications), '2000-01-01'),
    -- The day's note, and who was observing and scribing it. Absent here, setting one on the
    -- website moved no watermark this poll could see, so the phone learned about it only when
    -- something else happened to change or the user pressed Sync — which is exactly how it looked
    -- in the field: the pickers stayed empty until the button was hit.
    COALESCE((SELECT MAX(updated_at) FROM day_notes), '2000-01-01'),
    -- Every audited write, which is the same thing snapshot.php's own watermark uses. Named tables
    -- will always lag the payload by whatever was added last; this does not. It covers biometrics
    -- and chips, neither of which has an updated_at of its own to watch.
    COALESCE((SELECT MAX(change_timestamp) FROM audit_log), '2000-01-01')
) as wm");
$wm = $stmt->fetch()['wm'];

// Hard deletes move no timestamp, so timestamps alone miss them. Folding per-table row
// counts into the watermark makes any delete (or insert) register as a change; the
// client's next incremental sync then hits the _counts mismatch check and fully reloads.
$c = $pdo->query("SELECT
    (SELECT COUNT(*) FROM observations) AS o,
    (SELECT COUNT(*) FROM penguin_scans) AS s,
    (SELECT COUNT(*) FROM penguins) AS p,
    (SELECT COUNT(*) FROM penguin_chips) AS ch,
    (SELECT COUNT(*) FROM observation_locations) AS l,
    (SELECT COUNT(*) FROM penguin_biometric_data) AS b,
    (SELECT COUNT(*) FROM breeding_verifications) AS v")->fetch();
$wm .= "|{$c['o']}:{$c['s']}:{$c['p']}:{$c['ch']}:{$c['l']}:{$c['b']}:{$c['v']}";

$lastWm = $_GET['wm'] ?? '';
echo json_encode(['changed' => $lastWm !== '' && $lastWm !== $wm, 'wm' => $wm]);
