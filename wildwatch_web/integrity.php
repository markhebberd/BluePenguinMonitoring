<?php
/**
 * Data-integrity dismissals — mark a computed integrity-check error as reviewed/OK.
 *
 *   GET  /penguin-api/integrity.php?colony_id=N                    - list the colony's dismissals
 *   POST /penguin-api/integrity.php?action=dismiss&colony_id=N     - create/update a dismissal
 *          body: { error_type, error_key, content_hash, reason? }
 *   POST /penguin-api/integrity.php?action=undismiss&colony_id=N   - remove a dismissal
 *          body: { error_type, error_key }
 *
 * GET needs colony view; writes need colony edit (Bearer token).
 * The integrity checks themselves are computed client-side; this only stores/serves
 * the "reviewed & OK" suppressions the client filters against.
 */
require_once 'config.php';

setHeaders();

$pdo = getDbConnection();
$method = $_SERVER['REQUEST_METHOD'];
$colonyId = (int)($_GET['colony_id'] ?? 1);
$action = $_GET['action'] ?? '';

if ($method === 'GET') {
    $observer = requireReadAuth($pdo);
    requireColonyAccess($pdo, $observer, $colonyId);
    $stmt = $pdo->prepare("
        SELECT d.error_type, d.error_key, d.content_hash, d.reason,
               d.dismissed_by, d.dismissed_at, ob.observer_name AS dismissed_by_name
        FROM validation_dismissals d
        LEFT JOIN observers ob ON d.dismissed_by = ob.observer_id
        WHERE d.colony_id = ?");
    $stmt->execute([$colonyId]);
    echo json_encode(['dismissals' => $stmt->fetchAll()]);
    exit;
}

if ($method === 'POST') {
    $observer = requireAuth($pdo);
    requireColonyAccess($pdo, $observer, $colonyId, true);
    $observerId = is_array($observer) ? (int)$observer['observer_id'] : null;

    $body = json_decode(file_get_contents('php://input'), true) ?: [];
    $errorType = trim($body['error_type'] ?? '');
    $errorKey  = (string)($body['error_key'] ?? '');
    if ($errorType === '' || $errorKey === '') {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'error_type and error_key required']);
        exit;
    }

    if ($action === 'dismiss') {
        $contentHash = trim($body['content_hash'] ?? '');
        if ($contentHash === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'error' => 'content_hash required']);
            exit;
        }
        $reason = isset($body['reason']) ? mb_substr(trim($body['reason']), 0, 255) : null;
        if ($reason === '') $reason = null;
        // Dismissing an integrity check hides a data problem from every other user — audited
        // like any other write, so who hid what (and why) survives the row being deleted.
        $pdo->beginTransaction();
        try {
            wwAuditedUpsert($pdo, 'validation_dismissals', ['colony_id', 'error_type', 'error_key'],
                ['colony_id' => $colonyId, 'error_type' => $errorType, 'error_key' => $errorKey,
                 'content_hash' => $contentHash, 'reason' => $reason, 'dismissed_by' => $observerId,
                 'dismissed_at' => date('Y-m-d H:i:s')],   // re-dismissing refreshes the timestamp
                $observerId, $reason);
            $pdo->commit();
        } catch (Exception $e) { $pdo->rollBack(); http_response_code(500); echo json_encode(['success' => false, 'error' => $e->getMessage()]); exit; }
        echo json_encode(['success' => true]);
        exit;
    }

    if ($action === 'undismiss') {
        $sel = $pdo->prepare("SELECT id FROM validation_dismissals WHERE colony_id = ? AND error_type = ? AND error_key = ?");
        $sel->execute([$colonyId, $errorType, $errorKey]);
        $pdo->beginTransaction();
        try {
            foreach ($sel->fetchAll(PDO::FETCH_COLUMN) as $dismissalId) {
                wwAuditedDelete($pdo, 'validation_dismissals', $dismissalId, $observerId, 'Undismissed');
            }
            $pdo->commit();
        } catch (Exception $e) { $pdo->rollBack(); http_response_code(500); echo json_encode(['success' => false, 'error' => $e->getMessage()]); exit; }
        echo json_encode(['success' => true]);
        exit;
    }

    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Unknown action']);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'error' => 'Method not allowed']);
