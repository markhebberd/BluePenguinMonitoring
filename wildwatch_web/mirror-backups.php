<?php
/**
 * The backup mirror's inventory, and a way to ask it for a run.
 *
 * Runs on the mirror only, and says so by what it can see rather than by configuration: the
 * inventory is the file nightly.sh writes into the status mount, and the request drops a flag
 * into the one writable mount. Neither exists on production, so both 404 there.
 *
 * Behind the API key (requireReadAuth), so production can call it machine-to-machine without a
 * session, and nothing about the colony is exposed to an unauthenticated caller. What it
 * returns is a list of file names, sizes and dates plus the last run's verdict — never data.
 *
 *   GET  /api/mirror-backups.php            what this mirror holds, and what the last run proved
 *   POST /api/mirror-backups.php?run=1      queue a backup+restore run (a flag; root acts on it)
 *
 * A run is refused if one was asked for less than MIN_GAP ago: the run takes minutes and a
 * second request inside that window can only interrupt or duplicate it.
 */
require_once 'config.php';

const MIN_GAP = 900;                       // 15 minutes between accepted requests
const INVENTORY = '/var/www/status/backups.json';
const TRIGGERS  = '/var/www/triggers';
const MARKER    = TRIGGERS . '/.last-backup-request';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$pdo = getDbConnection();

/**
 * requireReadAuth accepts the API key on GET only — a read key must not be able to write data.
 * The POST here writes no data: it touches a flag file that a root watcher turns into a run of
 * one fixed script, and it is refused inside 15 minutes of the last one. Production has no
 * session on the mirror (separate app, separate sessions table), so a key it can present is the
 * only way it can ask at all. Hence an explicit key check for this endpoint, matching
 * requireReadAuth's own two sources.
 */
function mirrorAuth($pdo): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') { requireReadAuth($pdo); return; }
    $headers = array_change_key_case(getallheaders(), CASE_LOWER);
    $key = (string)($headers['x-api-key'] ?? '');
    if ($key !== '') {
        if (hash_equals(API_KEY, $key)) return;
        $stmt = $pdo->prepare("SELECT 1 FROM users WHERE api_key = ? AND (deleted_at IS NULL)");
        $stmt->execute([$key]);
        if ($stmt->fetchColumn()) return;
    }
    // A logged-in admin on the mirror itself can also queue a run; that is the existing button.
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
        $stmt = $pdo->prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > NOW()");
        $stmt->execute([$m[1]]);
        if ($stmt->fetchColumn()) return;
    }
    http_response_code(401);
    echo json_encode(['error' => 'Authentication required']);
    exit;
}
mirrorAuth($pdo);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!is_dir(TRIGGERS) || !is_writable(TRIGGERS)) {
        http_response_code(404); echo json_encode(['error' => 'Not a backup mirror']); exit;
    }
    $last = is_file(MARKER) ? (int)filemtime(MARKER) : 0;
    $age  = time() - $last;
    if ($last && $age < MIN_GAP) {
        http_response_code(429);
        echo json_encode([
            'error' => 'A run was already requested recently',
            'requested_seconds_ago' => $age,
            'retry_after_seconds' => MIN_GAP - $age,
        ]);
        exit;
    }
    // Same contract as the admin button: drop a flag, never run anything. The host watcher
    // (root) is the only thing that acts on it, and only ever runs nightly.sh.
    if (@touch(TRIGGERS . '/backup.req') === false) {
        http_response_code(500); echo json_encode(['error' => 'Could not queue the run']); exit;
    }
    @touch(MARKER);
    echo json_encode(['queued' => true, 'message' => 'Backup + restore queued — starts within a minute.']);
    exit;
}

if (!is_file(INVENTORY)) {
    // No inventory means either not a mirror, or a mirror that has not completed a run yet.
    http_response_code(404);
    echo json_encode(['error' => is_dir(TRIGGERS) ? 'No run has completed yet' : 'Not a backup mirror']);
    exit;
}

// Served as-is: nightly.sh is what knows the truth about the backups, and re-deriving any of
// it here would just be a second opinion that could disagree.
$raw = file_get_contents(INVENTORY);
$json = json_decode($raw, true);
if (!is_array($json)) {
    http_response_code(500); echo json_encode(['error' => 'Inventory unreadable']); exit;
}
$json['inventory_age_seconds'] = time() - (int)filemtime(INVENTORY);
echo json_encode($json);
