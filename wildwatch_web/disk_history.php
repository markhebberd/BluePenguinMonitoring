<?php
/**
 * Disk free-space history.
 *
 * RECORD (cron, every 15 min):
 *   - CLI:  php /home/wildwatch/public_html/penguin-api/disk_history.php
 *   - HTTP: curl "https://wildwatch.co.nz/penguin-api/disk_history.php?cron=<API_KEY>"
 *   Samples server free space and appends a row. Auto-creates the table and
 *   prunes samples older than 400 days.
 *
 * READ (admin UI):
 *   GET ?range=day|week|month|year   (Bearer token, admin role)
 *   - day:   raw 15-min samples
 *   - else:  one row per local day with min/max/avg free space (the daily low)
 */
require_once __DIR__ . '/config.php';

/**
 * Low-space warning, throttled to once per 12h via a shared state file.
 * Defined here (as well as in disk_check.php) so the alert fires regardless of
 * which script the cron invokes. The HTTP path runs under the web SAPI, whose
 * mail() is known to deliver (the CLI cron's mail did not).
 */
function ww_maybe_alert_low_disk($freeMb) {
    $thresholdMb = 50 * 1024; // 50 GB
    if ($freeMb === null || $freeMb >= $thresholdMb) return false;
    $stateFile = __DIR__ . '/disk_alert_last.txt';
    $last = @file_get_contents($stateFile);
    if ($last !== false && (time() - (int)$last) < 12 * 3600) return false; // throttle 12h
    $to = 'mark@wildwatch.co.nz'; $from = 'mark@wildwatch.co.nz';
    $freeGb = round($freeMb / 1024, 1); $thresholdGb = (int)round($thresholdMb / 1024);
    $headers = "From: $from\r\nReply-To: $from\r\nContent-Type: text/plain; charset=UTF-8";
    $ok = @mail($to, "DISK LOW ({$freeGb} GB free) - wildwatch.co.nz",
        "Server free space is {$freeMb} MB (~{$freeGb} GB), below the {$thresholdGb} GB warning threshold, at " . date('Y-m-d H:i:s T') . ".",
        $headers, "-f$from");
    if ($ok) @file_put_contents($stateFile, (string)time());
    return $ok;
}

// --- RECORD MODE: CLI cron, or HTTP with ?cron=<API_KEY> ---
// (The live 15-min sample is normally taken by disk_check.php's cron; this
//  path is a standalone fallback / manual trigger.)
$isCli = php_sapi_name() === 'cli';
$cronKey = $_GET['cron'] ?? '';
if ($isCli || ($cronKey !== '' && hash_equals(API_KEY, $cronKey))) {
    $freeMb = recordDiskSample(getDbConnection());
    if (!$isCli) header('Content-Type: application/json');
    if ($freeMb === null) {
        if (!$isCli) http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'disk_free_space failed']);
        exit;
    }
    ww_maybe_alert_low_disk($freeMb); // low-space warning fires from whichever cron records the sample
    echo json_encode(['ok' => true, 'disk_free_mb' => $freeMb, 'low_disk_threshold_mb' => 50 * 1024]);
    exit;
}

// --- READ MODE: admin only ---
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();
$observer = requireAuth($pdo);
if (($observer['role'] ?? '') !== 'admin') {
    http_response_code(403);
    echo json_encode(['error' => 'Admin required']);
    exit;
}
$pdo->exec("CREATE TABLE IF NOT EXISTS disk_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    recorded_at DATETIME NOT NULL,
    disk_free_mb INT NOT NULL,
    INDEX idx_recorded_at (recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

$range = $_GET['range'] ?? 'day';
// NZ local time for daily grouping (matches existing reports; ignores DST like the rest of the app).
$tz = '+12:00';

// Raw 15-min samples for the shorter ranges (day, week).
$rawDays = ['day' => 1, 'week' => 7];
if (isset($rawDays[$range])) {
    $d = (int)$rawDays[$range];
    $stmt = $pdo->query("SELECT UNIX_TIMESTAMP(recorded_at) * 1000 AS t, disk_free_mb
        FROM disk_history
        WHERE recorded_at >= UTC_TIMESTAMP() - INTERVAL $d DAY
        ORDER BY recorded_at");
    $points = [];
    foreach ($stmt as $r) {
        $points[] = ['t' => (int)$r['t'], 'free_mb' => (int)$r['disk_free_mb']];
    }
    echo json_encode(['range' => $range, 'daily' => false, 'points' => $points]);
    exit;
}

// Per-day min/max/avg (the daily low) for the longer ranges.
$days = ['month' => 31, 'year' => 366][$range] ?? null;
if ($days === null) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid range']);
    exit;
}

// $days is a whitelisted int and $tz a constant offset — safe to inline.
$days = (int)$days;
$stmt = $pdo->query("SELECT DATE(CONVERT_TZ(recorded_at, '+00:00', '$tz')) AS d,
        MIN(disk_free_mb) AS min_mb, MAX(disk_free_mb) AS max_mb, ROUND(AVG(disk_free_mb)) AS avg_mb
    FROM disk_history
    WHERE recorded_at >= UTC_TIMESTAMP() - INTERVAL $days DAY
    GROUP BY d
    ORDER BY d");
$points = [];
foreach ($stmt as $r) {
    $points[] = [
        'd' => $r['d'],
        'min_mb' => (int)$r['min_mb'],
        'max_mb' => (int)$r['max_mb'],
        'avg_mb' => (int)$r['avg_mb'],
    ];
}
echo json_encode(['range' => $range, 'daily' => true, 'points' => $points]);
