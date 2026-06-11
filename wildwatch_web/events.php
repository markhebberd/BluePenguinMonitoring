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
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
requireAuth();

$pdo = getDbConnection();
$stmt = $pdo->query("SELECT GREATEST(
    COALESCE((SELECT MAX(updated_at) FROM observations), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM penguins), '2000-01-01'),
    COALESCE((SELECT MAX(updated_at) FROM observation_locations), '2000-01-01')
) as wm");
$wm = $stmt->fetch()['wm'];

$lastWm = $_GET['wm'] ?? '';
echo json_encode(['changed' => $lastWm !== '' && $lastWm !== $wm, 'wm' => $wm]);
