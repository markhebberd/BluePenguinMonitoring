<?php
/**
 * Test disk descent alert email.
 * Simulates running the check as if it were 14:00 NZ time on 21 Jun 2026.
 *
 * HTTP: GET ?cron=<API_KEY>
 * CLI:  php test_disk_alert.php
 */
require_once __DIR__ . '/config.php';

$isCli = php_sapi_name() === 'cli';
if (!$isCli) {
    $cronKey = $_GET['cron'] ?? '';
    if (!hash_equals(API_KEY, $cronKey)) {
        http_response_code(403);
        echo json_encode(['error' => 'Forbidden']);
        exit;
    }
    header('Content-Type: application/json');
}

$pdo = getDbConnection();

// 14:00 NZST = 02:00 UTC (NZST = UTC+12)
$asOfUtc = '2026-06-21 02:00:00';

$result = checkDiskDescentAlert($pdo, $asOfUtc, ['markhebberd@gmail.com', 'bdot@snotch.com']);

if ($isCli) {
    if ($result) {
        echo "Alert triggered!\n";
        echo "  Drop rate: {$result['slope_mb_per_min']} MB/min ({$result['gb_per_hr']} GB/hr)\n";
        echo "  Duration: {$result['duration_min']} min\n";
        echo "  R²: {$result['r2']}\n";
        echo "  Current free: " . round($result['current_free_mb'] / 1024, 1) . " GB\n";
        echo "  Hits zero: {$result['zero_time_nz']}\n";
        echo "  Hours to zero: {$result['hours_to_zero']}\n";
        echo "  Emailed: " . implode(', ', $result['emailed']) . "\n";
    } else {
        echo "No descent detected at that time\n";
    }
} else {
    echo json_encode($result ?: ['detected' => false, 'as_of_utc' => $asOfUtc]);
}
