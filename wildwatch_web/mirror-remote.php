<?php
/**
 * Production's view of the backup mirror.
 *
 * The mirror is outbound-only except for its Cloudflare tunnel, and its hostname and Access
 * policy live in the Cloudflare dashboard rather than in this repo — so whether production can
 * reach it is a deployment fact, not something the code can assume. This asks, on the server so
 * the mirror's key never reaches a browser, and reports the answer either way: an inventory, or
 * a named reason it could not be had. "I don't know" is a state the admin page should show, not
 * one it should hide behind an empty card.
 *
 *   GET  /api/mirror-remote.php        the mirror's inventory, or why it's unavailable
 *   POST /api/mirror-remote.php?run=1  ask the mirror to run a backup + restore
 *
 * Admin-only: it speaks for the copy of the colony's data.
 */
require_once 'config.php';

$pdo = getDbConnection();
$observer = requireAuth($pdo);
header('Content-Type: application/json');
header('Cache-Control: no-store');
if (($observer['role'] ?? '') !== 'admin') {
    http_response_code(403); echo json_encode(['error' => 'Admin only']); exit;
}

// Both come from secrets.php; without them there is nothing to ask.
$url = defined('MIRROR_API_URL') ? MIRROR_API_URL : '';
$key = defined('MIRROR_API_KEY') ? MIRROR_API_KEY : '';
if ($url === '' || $key === '') {
    echo json_encode([
        'reachable' => false,
        'state' => 'not_configured',
        'detail' => 'MIRROR_API_URL / MIRROR_API_KEY are not set in secrets.php, so production has no address for the mirror.',
    ]);
    exit;
}

$run = $_SERVER['REQUEST_METHOD'] === 'POST';
$ch = curl_init($url . ($run ? (str_contains($url, '?') ? '&run=1' : '?run=1') : ''));
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['X-API-Key: ' . $key, 'Accept: application/json'],
    // Short: this is a page load, and a mirror that is asleep should say so quickly rather
    // than hang the admin tab.
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_FOLLOWLOCATION => false,
]);
if ($run) { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, ''); }
$body = curl_exec($ch);
$code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$err  = curl_error($ch);
curl_close($ch);

if ($body === false || $code === 0) {
    echo json_encode(['reachable' => false, 'state' => 'unreachable', 'detail' => $err ?: 'No response from the mirror.']);
    exit;
}

$json = json_decode((string)$body, true);
if (!is_array($json)) {
    // Cloudflare Access answers an unauthenticated machine call with an HTML login page. That
    // is the most likely non-JSON reply here, and it means the tunnel is up but the policy is
    // not letting production through — a different problem from the mirror being down.
    $looksLikeAccess = stripos((string)$body, 'cloudflareaccess') !== false || stripos((string)$body, '<html') !== false;
    echo json_encode([
        'reachable' => false,
        'state' => $looksLikeAccess ? 'blocked_by_access' : 'bad_response',
        'http' => $code,
        'detail' => $looksLikeAccess
            ? 'The tunnel answered with an HTML page, not JSON — Cloudflare Access is gating the request. A service token (or a bypass on this path) would let production through.'
            : 'The mirror replied with something that is not JSON.',
    ]);
    exit;
}

// 404 from the mirror is meaningful, not an error: it is how the mirror endpoint says "not a
// mirror" or "no run has completed yet".
if ($code >= 400) {
    echo json_encode(['reachable' => true, 'state' => $code === 429 ? 'rate_limited' : 'error', 'http' => $code] + $json);
    exit;
}
echo json_encode(['reachable' => true, 'state' => $run ? 'queued' : 'ok'] + $json);
