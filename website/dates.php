<?php
/**
 * Date mappings API - public read, auth write
 * GET  ?season=25     - get all mappings for season 2025
 * POST ?season=25     - set mappings (JSON array of {n: 1, date: "2025-07-26"})
 */
require_once 'config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();
$seasonInput = $_GET['season'] ?? '';
$season = strlen($seasonInput) === 2 ? 2000 + intval($seasonInput) : intval($seasonInput);

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = $pdo->prepare("SELECT date_number, actual_date FROM date_mappings WHERE season_year = ? ORDER BY date_number");
    $stmt->execute([$season]);
    echo json_encode($stmt->fetchAll());
} else {
    // Auth required for writes
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
        http_response_code(401); echo json_encode(['error'=>'Auth required']); exit;
    }
    $stmt = $pdo->prepare("SELECT o.* FROM sessions s JOIN observers o ON s.observer_id = o.observer_id WHERE s.token = ? AND s.expires_at > NOW()");
    $stmt->execute([$m[1]]);
    if (!$stmt->fetch()) { http_response_code(401); echo json_encode(['error'=>'Invalid token']); exit; }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !is_array($input)) { http_response_code(400); echo json_encode(['error'=>'JSON array required']); exit; }

    $pdo->beginTransaction();
    try {
        $pdo->prepare("DELETE FROM date_mappings WHERE season_year = ?")->execute([$season]);
        $stmt = $pdo->prepare("INSERT INTO date_mappings (season_year, date_number, actual_date) VALUES (?, ?, ?)");
        foreach ($input as $row) {
            $stmt->execute([$season, $row['n'], $row['date']]);
        }
        $pdo->commit();
        echo json_encode(['success'=>true, 'count'=>count($input)]);
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(400); echo json_encode(['error'=>$e->getMessage()]);
    }
}
