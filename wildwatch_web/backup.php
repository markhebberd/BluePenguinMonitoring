<?php
/**
 * Database backup via pure PHP.
 * Returns a gzipped SQL dump with CREATE TABLE + INSERT statements.
 * Schema-safe: uses SHOW CREATE TABLE so it adapts to any schema changes.
 *
 * GET /penguin-api/backup.php
 * Requires X-API-Key header.
 */
ini_set('display_errors', 0);
set_exception_handler(function($e) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => $e->getMessage(), 'line' => $e->getLine()]);
    exit;
});

require_once 'config.php';
validateApiKey();

ini_set('memory_limit', '256M');
set_time_limit(120);

$pdo = getDbConnection();

$sql = "-- Wildwatch backup " . date('Y-m-d H:i:s') . "\n";
$sql .= "-- Database: " . DB_NAME . "\n\n";
$sql .= "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n";

$tables = $pdo->query("SHOW TABLES")->fetchAll(PDO::FETCH_COLUMN);

foreach ($tables as $table) {
    $create = $pdo->query("SHOW CREATE TABLE `$table`")->fetch();
    $createSql = $create['Create Table'] ?? $create['Create View'] ?? '';
    $sql .= "DROP TABLE IF EXISTS `$table`;\n$createSql;\n\n";

    $rows = $pdo->query("SELECT * FROM `$table`")->fetchAll();
    if (empty($rows)) continue;

    $cols = array_keys($rows[0]);
    $colList = implode(', ', array_map(function($c) { return "`$c`"; }, $cols));

    // Batch inserts in groups of 500
    foreach (array_chunk($rows, 500) as $chunk) {
        $values = [];
        foreach ($chunk as $row) {
            $vals = [];
            foreach ($row as $val) {
                $vals[] = $val === null ? 'NULL' : $pdo->quote($val);
            }
            $values[] = '(' . implode(',', $vals) . ')';
        }
        $sql .= "INSERT INTO `$table` ($colList) VALUES\n" . implode(",\n", $values) . ";\n\n";
    }
}

$sql .= "SET FOREIGN_KEY_CHECKS = 1;\n";

$gz = gzencode($sql, 6);

header('Content-Type: application/gzip');
header('Content-Disposition: attachment; filename="wildwatch_' . date('Y-m-d') . '.sql.gz"');
header('Content-Length: ' . strlen($gz));
echo $gz;
