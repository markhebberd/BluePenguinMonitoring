<?php
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();

// DB size
$stmt = $pdo->query("SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) AS db_mb FROM information_schema.TABLES WHERE table_schema = DATABASE()");
$dbMb = (float)$stmt->fetchColumn();

// File size (public_html)
$home = dirname(__DIR__, 2);
$fileMb = 0;
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$home/public_html", FilesystemIterator::SKIP_DOTS)) as $f) {
    $fileMb += $f->getSize();
}
$fileMb = round($fileMb / 1048576, 1);

// Row counts
$obs = (int)$pdo->query("SELECT COUNT(*) FROM observations WHERE is_deleted = FALSE")->fetchColumn();
$scans = (int)$pdo->query("SELECT COUNT(*) FROM penguin_scans")->fetchColumn();
$penguins = (int)$pdo->query("SELECT COUNT(*) FROM penguins")->fetchColumn();

echo json_encode([
    'db_mb' => $dbMb,
    'files_mb' => $fileMb,
    'total_mb' => $dbMb + $fileMb,
    'observations' => $obs,
    'scans' => $scans,
    'penguins' => $penguins,
]);
