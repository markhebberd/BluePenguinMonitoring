<?php
/**
 * Backup-mirror status, for the "Backup" admin tab in the SPA.
 *
 * Only meaningful on the backup mirror: production never defines IS_MIRROR (config.php
 * defaults it to false), so this 404s there. On the mirror it returns the standalone status
 * page nightly.sh writes each night (the same content as /status/). The SPA embeds it in an
 * isolated <iframe srcdoc>, so no style scoping is needed. Requires a logged-in admin -- the
 * colony data behind the mirror is production's, so its backup health is admin-only.
 *
 * GET /api/status.php
 */
require_once 'config.php';
$pdo = getDbConnection();
$observer = requireAuth($pdo);   // 401 if not logged in

header('Cache-Control: no-cache');
if (($observer['role'] ?? '') !== 'admin') {
    http_response_code(403); header('Content-Type: application/json');
    echo json_encode(['error' => 'Admin only']); exit;
}
if (!defined('IS_MIRROR') || !IS_MIRROR) {
    http_response_code(404); header('Content-Type: application/json');
    echo json_encode(['error' => 'Not a backup mirror']); exit;
}

// POST = request an on-demand action. We only DROP a flag file into the triggers dir; a
// root host-watcher picks it up and runs the fixed script. The web app never runs host
// commands, so even a compromise here can at worst re-queue a backup, not execute anything.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');
    $trig = '/var/www/triggers';
    if (!is_dir($trig) || !is_writable($trig)) {
        http_response_code(500); echo json_encode(['error' => 'Triggers dir not writable']); exit;
    }
    $action = $_GET['action'] ?? '';
    if ($action === 'backup') {
        touch("$trig/backup.req");
        echo json_encode(['message' => 'Backup + restore queued — starts within a minute, takes a few minutes.']); exit;
    }
    if ($action === 'release') {
        touch("$trig/release.req");
        echo json_encode(['message' => 'App-code refresh queued — starts within a minute.']); exit;
    }
    http_response_code(400); echo json_encode(['error' => 'Unknown action']); exit;
}

// GET = serve the standalone status page (embedded by the SPA in an iframe).
// The mirror mounts its status dir at /var/www/status (sibling of the html docroot).
$page = __DIR__ . '/../../status/index.html';
if (!is_readable($page)) {
    http_response_code(404); header('Content-Type: application/json');
    echo json_encode(['error' => 'No status yet -- the nightly run has not produced one']); exit;
}
header('Content-Type: text/html; charset=utf-8');
readfile($page);
