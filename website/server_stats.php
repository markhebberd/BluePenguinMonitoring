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

// Account usage from du
$duOutput = trim(shell_exec('du -sm /home/wildwatch 2>/dev/null') ?? '');
$usedMb = $duOutput ? (float)explode("\t", $duOutput)[0] : ($dbMb + $fileMb);
$quotaMb = 12001; // 11.72 GB per cPanel

// CPU and RAM from /proc
$loadAvg = sys_getloadavg();
$cpuPct = round($loadAvg[0] * 100 / max(1, (int)shell_exec('nproc 2>/dev/null') ?: 1), 1);
$memInfo = @file_get_contents('/proc/meminfo');
$ramUsedMb = 0; $ramTotalMb = 0;
if ($memInfo && preg_match('/MemTotal:\s+(\d+)/', $memInfo, $mt) && preg_match('/MemAvailable:\s+(\d+)/', $memInfo, $ma)) {
    $ramTotalMb = round($mt[1] / 1024);
    $ramUsedMb = round(($mt[1] - $ma[1]) / 1024);
}

$diskFreeGb = round(@disk_free_space(__DIR__) / 1073741824, 1);

echo json_encode([
    'db_mb' => $dbMb,
    'files_mb' => $fileMb,
    'used_mb' => $usedMb,
    'quota_mb' => $quotaMb,
    'pct' => round($usedMb / $quotaMb * 100, 1),
    'disk_free_gb' => $diskFreeGb,
    'error_log_mb' => $errorLogMb,
    'cpu_pct' => $cpuPct,
    'ram_used_mb' => $ramUsedMb,
    'ram_total_mb' => $ramTotalMb,
    'observations' => $obs,
    'scans' => $scans,
    'penguins' => $penguins,
]);
