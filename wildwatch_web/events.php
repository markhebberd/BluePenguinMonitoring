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
    COALESCE((SELECT MAX(updated_at) FROM colonies), '2000-01-01')
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
    (SELECT COUNT(*) FROM penguin_biometric_data) AS b")->fetch();
$wm .= "|{$c['o']}:{$c['s']}:{$c['p']}:{$c['ch']}:{$c['l']}:{$c['b']}";

$lastWm = $_GET['wm'] ?? '';
echo json_encode(['changed' => $lastWm !== '' && $lastWm !== $wm, 'wm' => $wm]);
