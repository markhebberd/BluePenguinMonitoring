<?php
require_once 'config.php';
setHeaders();
$headers = getallheaders();
$apiKey = $headers['X-API-Key'] ?? $headers['x-api-key'] ?? '';
if ($apiKey !== API_KEY) { http_response_code(401); echo json_encode(['error' => 'Bad key']); exit; }
$pdo = getDbConnection();

$results = [];

// Step 1: Add colony_prefix
try {
    $pdo->exec("ALTER TABLE colonies ADD COLUMN colony_prefix VARCHAR(4) AFTER colony_name");
    $results[] = 'Added colony_prefix column';
} catch (Exception $e) {
    $results[] = 'colony_prefix: ' . $e->getMessage();
}

$pdo->exec("UPDATE colonies SET colony_prefix = 'PT' WHERE colony_id = 1");
$pdo->exec("UPDATE colonies SET colony_prefix = 'NI' WHERE colony_id = 2");
$results[] = 'Set PT for colony 1, NI for colony 2';

// Step 2: Prefix peng_num in all tables
$pdo->exec("SET FOREIGN_KEY_CHECKS = 0");

$r1 = $pdo->exec("UPDATE penguins SET peng_num = CONCAT('PT', peng_num) WHERE peng_num REGEXP '^[0-9]'");
$results[] = "penguins: $r1 rows updated";

$r2 = $pdo->exec("UPDATE penguin_chips SET peng_num = CONCAT('PT', peng_num) WHERE peng_num REGEXP '^[0-9]'");
$results[] = "penguin_chips: $r2 rows updated";

$r3 = $pdo->exec("UPDATE penguin_biometric_data SET peng_num = CONCAT('PT', peng_num) WHERE peng_num REGEXP '^[0-9]'");
$results[] = "penguin_biometric_data: $r3 rows updated";

$pdo->exec("SET FOREIGN_KEY_CHECKS = 1");

// Step 3: Verify no orphans
$orphanChips = $pdo->query("SELECT COUNT(*) FROM penguin_chips WHERE peng_num NOT IN (SELECT peng_num FROM penguins)")->fetchColumn();
$orphanBio = $pdo->query("SELECT COUNT(*) FROM penguin_biometric_data WHERE peng_num NOT IN (SELECT peng_num FROM penguins)")->fetchColumn();
$unprefixed = $pdo->query("SELECT COUNT(*) FROM penguins WHERE peng_num NOT LIKE 'PT%' AND peng_num NOT LIKE 'NI%'")->fetchColumn();
$results[] = "Orphan chips: $orphanChips, orphan bio: $orphanBio, unprefixed penguins: $unprefixed";

echo json_encode(['status' => 'ok', 'results' => $results], JSON_PRETTY_PRINT);
