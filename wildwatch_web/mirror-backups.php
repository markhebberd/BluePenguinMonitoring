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
 * A run is refused only while one is already going — that is the whole rule. There is no time
 * window: once a run has finished, asking for another is a reasonable thing to want.
 */
require_once 'config.php';

const INVENTORY = '/var/www/status/backups.json';
const RUNLOCK   = '/var/www/status/running';   // nightly.sh holds this for the length of a run
const TRIGGERS  = '/var/www/triggers';
const REQUEST   = TRIGGERS . '/backup.req';    // queued, not yet picked up by the host watcher

/** A run is under way if it has been asked for and not yet finished. No time window: the only
 *  thing worth refusing is a second run on top of the first. */
function runInProgress(): bool { return is_file(REQUEST) || is_file(RUNLOCK); }

header('Content-Type: application/json');
header('Cache-Control: no-store');

$pdo = getDbConnection();

/**
 * requireReadAuth accepts the API key on GET only — a read key must not be able to write data.
 * The POST here writes no data: it touches a flag file that a root watcher turns into a run of
 * one fixed script, and it is refused while a run is already going. Production has no
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
    if (runInProgress()) {
        http_response_code(409);
        echo json_encode([
            'error' => 'A run is already going',
            'running' => true,
            'started_seconds_ago' => is_file(RUNLOCK) ? time() - (int)filemtime(RUNLOCK) : null,
        ]);
        exit;
    }
    // Same contract as the admin button: drop a flag, never run anything. The host watcher
    // (root) is the only thing that acts on it, and only ever runs nightly.sh.
    if (@touch(REQUEST) === false) {
        http_response_code(500); echo json_encode(['error' => 'Could not queue the run']); exit;
    }
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
// Whether a run is going right now, so a caller can wait for it rather than ask again.
$json['running'] = runInProgress();
$json['running_seconds'] = is_file(RUNLOCK) ? time() - (int)filemtime(RUNLOCK) : null;
echo json_encode($json);
