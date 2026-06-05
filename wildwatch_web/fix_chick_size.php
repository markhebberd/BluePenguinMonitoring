<?php
/**
 * One-time script: extract BC/LC/SC from vid_for_scanner into chick_size_code
 */
require_once 'config.php';
header('Content-Type: application/json');
validateApiKey();

$pdo = getDbConnection();
$stmt = $pdo->query("SELECT peng_num, vid_for_scanner, chick_size_code FROM penguins WHERE vid_for_scanner IS NOT NULL");
$updated = 0;
$results = [];

foreach ($stmt->fetchAll() as $row) {
    $vid = $row['vid_for_scanner'];
    if (preg_match('/-(BC|LC|SC)/i', $vid, $m)) {
        $code = strtoupper($m[1]);
        $current = $row['chick_size_code'] ?? '';
        if ($current !== $code) {
            $pdo->prepare("UPDATE penguins SET chick_size_code = ? WHERE peng_num = ?")->execute([$code, $row['peng_num']]);
            $results[] = ['peng_num' => $row['peng_num'], 'vid' => $vid, 'old' => $current, 'new' => $code];
            $updated++;
        }
    }
}

echo json_encode(['updated' => $updated, 'samples' => array_slice($results, 0, 10)]);
