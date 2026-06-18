<?php
$alertEmail = 'mark@wildwatch.co.nz';
$alertFrom  = 'mark@wildwatch.co.nz'; // must be a REAL mailbox on this server — a non-existent noreply@ From got mail() rejected/dropped
$testFile = __DIR__ . '/disk_test.tmp';

/** Send a disk alert from a real local mailbox, with a valid envelope sender (-f) so the MTA accepts it. */
function sendDiskAlert($to, $from, $subject, $body) {
    $headers = "From: $from\r\nReply-To: $from\r\nContent-Type: text/plain; charset=UTF-8";
    return @mail($to, $subject, $body, $headers, "-f$from");
}

// Self-test: GET ?selftest=<API_KEY> — sends a test alert and reports whether mail() accepted it.
if (isset($_GET['selftest'])) {
    require_once __DIR__ . '/config.php';
    header('Content-Type: application/json');
    if (!hash_equals(API_KEY, (string)$_GET['selftest'])) { http_response_code(401); echo json_encode(['ok' => false, 'error' => 'bad key']); exit; }
    $ok = sendDiskAlert($alertEmail, $alertFrom, "wildwatch disk alert self-test", "Disk-alert self-test at " . date('Y-m-d H:i:s T') . ". If you received this, mail() works.");
    echo json_encode(['ok' => $ok, 'to' => $alertEmail, 'from' => $alertFrom]);
    exit;
}

// Cron mode (no params) — silent 100MB test with email
if (!isset($_GET['mb']) && php_sapi_name() === 'cli') {
    try {
        $fh = fopen($testFile, 'w');
        if (!$fh) throw new Exception("Cannot open file");
        for ($i = 0; $i < 1600; $i++) {
            if (fwrite($fh, str_repeat("X", 65536)) === false) throw new Exception("Write failed");
        }
        fclose($fh); @unlink($testFile);
    } catch (Exception $e) {
        @unlink($testFile);
        sendDiskAlert($alertEmail, $alertFrom, "DISK FULL - wildwatch.co.nz", "FAILED: " . $e->getMessage() . " at " . date('Y-m-d H:i:s T'));
    }
    // Record a free-space sample for the admin history graph (after cleanup,
    // so it reflects true free space rather than the test file).
    try {
        require_once __DIR__ . '/config.php';
        recordDiskSample(getDbConnection());
    } catch (Exception $e) { /* history sampling is best-effort */ }
    exit;
}

// Web mode — SSE streaming with progress
require_once 'config.php';
set_time_limit(300);
@ini_set('max_execution_time', '300');
@ini_set('output_buffering', 'Off');
@ini_set('zlib.output_compression', 'Off');
if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
header('Content-Type: text/event-stream');
header('Cache-Control: no-cache');
header('X-Accel-Buffering: no');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

function send($data) { echo "data: " . json_encode($data) . "\n\n"; if (ob_get_level()) ob_flush(); flush(); }
function getDiskFree() { $f = @disk_free_space(__DIR__); return $f !== false ? round($f / 1048576) : null; }

// Verify caller is admin
$pdo = getDbConnection();
$token = $_GET['token'] ?? '';
if (!$token) { send(['type' => 'error', 'msg' => 'Auth required']); exit; }
$stmt = $pdo->prepare("SELECT o.role FROM sessions s JOIN observers o ON s.observer_id = o.observer_id WHERE s.token = ? AND s.expires_at > NOW()");
$stmt->execute([$token]);
$user = $stmt->fetch();
if (!$user || $user['role'] !== 'admin') { send(['type' => 'error', 'msg' => 'Admin required']); exit; }

$mb = max(1, min(5000, (int)($_GET['mb'] ?? 100)));
$chunks = $mb * 16; // 64KB per chunk
$block = str_repeat("X", 65536);

function getServerStats($pdo) {
    $free = getDiskFree();
    $db = $pdo->query("SELECT ROUND(SUM(data_length + index_length) / 1048576, 1) as mb FROM information_schema.tables WHERE table_schema = DATABASE()")->fetch();
    $obs = $pdo->query("SELECT COUNT(*) as c FROM observations WHERE is_deleted = FALSE")->fetch();
    return ['disk_free_mb' => $free, 'db_mb' => (float)($db['mb'] ?? 0), 'observations' => (int)($obs['c'] ?? 0)];
}

$stats = getServerStats($pdo);
send(['type' => 'start', 'target_mb' => $mb, 'server' => $stats]);

try {
    $start = microtime(true);
    $fh = fopen($testFile, 'w');
    if (!$fh) throw new Exception("Cannot open file for writing");

    $lastUpdate = 0;
    for ($i = 0; $i < $chunks; $i++) {
        if (fwrite($fh, $block) === false) throw new Exception("Write failed at " . round($i * 64 / 1024, 1) . "MB");
        $pct = round(($i + 1) / $chunks * 100);
        if ($pct >= $lastUpdate + 5 || $i === $chunks - 1) {
            $writtenMB = round(($i + 1) * 65536 / 1048576, 1);
            $elapsed = round(microtime(true) - $start, 1);
            $speed = $elapsed > 0 ? round($writtenMB / $elapsed, 1) : 0;
            send(['type' => 'progress', 'pct' => $pct, 'written_mb' => $writtenMB, 'elapsed_sec' => $elapsed, 'speed_mbs' => $speed, 'disk_free_mb' => getDiskFree()]);
            $lastUpdate = $pct;
        }
    }
    fclose($fh);

    $fileSize = round(filesize($testFile) / 1048576, 1);
    $freeBeforeDelete = getDiskFree();
    @unlink($testFile);
    $freeAfterDelete = getDiskFree();
    $totalSec = round(microtime(true) - $start, 2);

    send(['type' => 'done', 'status' => 'OK', 'wrote_mb' => $fileSize, 'total_sec' => $totalSec, 'speed_mbs' => round($fileSize / $totalSec, 1), 'disk_free_before_delete' => $freeBeforeDelete, 'disk_free_after_delete' => $freeAfterDelete, 'server' => getServerStats($pdo)]);
} catch (Exception $e) {
    if (file_exists($testFile)) @unlink($testFile);
    send(['type' => 'done', 'status' => 'FAIL', 'error' => $e->getMessage(), 'server' => getServerStats($pdo)]);
}
