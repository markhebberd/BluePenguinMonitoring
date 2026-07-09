<?php
/**
 * BoxTags REST API — reads/writes observation_locations table
 *
 * Endpoints:
 *   GET    /penguin-api/boxtags.php           - Get all box tags
 *   GET    /penguin-api/boxtags.php?box_id=X  - Get single box tag
 *   GET    /penguin-api/boxtags.php?count      - Get count of tagged boxes
 *   POST   /penguin-api/boxtags.php           - Create or update box tag
 *   DELETE /penguin-api/boxtags.php?box_id=X  - Clear box tag
 *
 * GET: Bearer token or API key (read-only for legacy app)
 * POST/DELETE: Bearer token required
 */

require_once 'config.php';

setHeaders();

$method = $_SERVER['REQUEST_METHOD'];
$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? 1);

// GETs accept API key (legacy app), writes require Bearer
if ($method === 'GET') {
    $observer = requireReadAuth($pdo);
    requireColonyAccess($pdo, $observer, $colonyId);          // view
} else {
    $observer = requireAuth($pdo);
    requireColonyAccess($pdo, $observer, $colonyId, true);    // edit
}

switch ($method) {
    case 'GET': handleGet($pdo, $colonyId); break;
    case 'POST': handlePost($pdo, $colonyId); break;
    case 'DELETE': handleDelete($pdo, $colonyId); break;
    default:
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method not allowed']);
}

function handleGet($pdo, $colonyId) {
    if (isset($_GET['count'])) {
        $stmt = $pdo->prepare("SELECT COUNT(*) as c FROM observation_locations WHERE colony_id = ? AND pit_id IS NOT NULL");
        $stmt->execute([$colonyId]);
        echo json_encode(['success' => true, 'count' => (int)$stmt->fetch()['c']]);
        return;
    }

    $boxId = $_GET['box_id'] ?? null;

    if ($boxId) {
        $stmt = $pdo->prepare("SELECT * FROM observation_locations WHERE colony_id = ? AND location_name = ?");
        $stmt->execute([$colonyId, $boxId]);
        $row = $stmt->fetch();
        if ($row && ($row['pit_id'] || $row['latitude'] !== null)) {
            echo json_encode(['success' => true, 'data' => formatBoxTag($row)]);
        } else {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Box tag not found']);
        }
    } else {
        $stmt = $pdo->prepare("SELECT * FROM observation_locations WHERE colony_id = ? AND (pit_id IS NOT NULL OR latitude IS NOT NULL) ORDER BY location_name + 0, location_name");
        $stmt->execute([$colonyId]);
        $data = [];
        foreach ($stmt->fetchAll() as $row) {
            $data[$row['location_name']] = formatBoxTag($row);
        }
        echo json_encode(['success' => true, 'data' => (object)$data, 'count' => count($data)]);
    }
}

function auditBoxTag($pdo, $action, $boxId, $changed) {
    $observerId = $changed['observer_id'] ?? 0;
    unset($changed['observer_id']);
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observation_locations', ?, ?, ?, ?)")
        ->execute([$boxId, $action, $observerId, json_encode($changed)]);
}

/**
 * True if $boxId fits the colony's location_sets_string. Understands both formats
 * in use — "{1-150,AA-AC}" (braced, multiple sets) and bare "N1-N6" — with parts
 * that are numeric ranges (1-150), prefixed-numeric ranges (N1-N6), same-length
 * alpha ranges (AA-AC), or single names. An empty/unset sets string fails open
 * (an unconfigured colony must not lose tag saves).
 */
function boxFitsColonySets($pdo, $colonyId, $boxId) {
    $stmt = $pdo->prepare("SELECT location_sets_string FROM colonies WHERE colony_id = ?");
    $stmt->execute([$colonyId]);
    $sets = trim((string)$stmt->fetchColumn());
    if ($sets === '') return true;
    $box = strtoupper(trim($boxId));
    foreach (preg_split('/\},\{|\{|\}/', $sets, -1, PREG_SPLIT_NO_EMPTY) as $set) {
        foreach (explode(',', $set) as $part) {
            $part = strtoupper(trim($part));
            if ($part === '') continue;
            if (strpos($part, '-') !== false) {
                [$a, $b] = array_map('trim', explode('-', $part, 2));
                if (ctype_digit($a) && ctype_digit($b)) {                       // 1-150
                    if (ctype_digit($box) && (int)$box >= (int)$a && (int)$box <= (int)$b) return true;
                } elseif (preg_match('/^([A-Z]+)(\d+)$/', $a, $ma) && preg_match('/^([A-Z]+)(\d+)$/', $b, $mb)
                          && $ma[1] === $mb[1]) {                               // N1-N6
                    if (preg_match('/^([A-Z]+)(\d+)$/', $box, $mx) && $mx[1] === $ma[1]
                        && (int)$mx[2] >= (int)$ma[2] && (int)$mx[2] <= (int)$mb[2]) return true;
                } elseif (ctype_alpha($a) && ctype_alpha($b) && strlen($a) === strlen($b)) { // AA-AC
                    if (ctype_alpha($box) && strlen($box) === strlen($a)
                        && strcmp($box, $a) >= 0 && strcmp($box, $b) <= 0) return true;
                }
            } elseif ($part === $box) {
                return true;
            }
        }
    }
    return false;
}

function handlePost($pdo, $colonyId) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'Invalid JSON body']); return; }

    $boxId = $input['BoxID'] ?? $input['box_id'] ?? null;
    $tagNumber = $input['TagNumber'] ?? $input['tag_number'] ?? null;
    if ($tagNumber === '') $tagNumber = null;
    if (!$boxId) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'BoxID is required']); return; }

    // Reject box names outside the colony's configured sets — a stale-colony or mistyped
    // box must not silently create a phantom location (see the accidental Ngawhiti "box 1").
    if (!boxFitsColonySets($pdo, $colonyId, $boxId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => "Box '$boxId' is not in this colony's box sets"]);
        return;
    }

    $scanTime = date('Y-m-d H:i:s', strtotime($input['ScanTimeUTC'] ?? $input['scan_time_utc'] ?? 'now'));
    $latitude = $input['Latitude'] ?? $input['latitude'] ?? null;
    $longitude = $input['Longitude'] ?? $input['longitude'] ?? null;
    $accuracy = $input['Accuracy'] ?? $input['accuracy'] ?? null;
    $observerId = $input['ObserverId'] ?? $input['observer_id'] ?? 0;

    // Get old value for audit
    $old = $pdo->prepare("SELECT pit_id, scan_time_utc, latitude, longitude, accuracy FROM observation_locations WHERE colony_id = ? AND location_name = ?");
    $old->execute([$colonyId, $boxId]);
    $oldRow = $old->fetch();

    // Ensure location exists
    $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")->execute([$colonyId, $boxId]);

    $audit = [
        'scan_time_utc' => ['old' => $oldRow['scan_time_utc'] ?? null, 'new' => $scanTime],
        'latitude' => ['old' => $oldRow['latitude'] ?? null, 'new' => $latitude],
        'longitude' => ['old' => $oldRow['longitude'] ?? null, 'new' => $longitude],
        'observer_id' => $observerId,
        'source' => 'nestcheck_app',
    ];

    if ($tagNumber !== null) {
        // Update pit_id, scan time, and GPS
        $pdo->prepare("UPDATE observation_locations SET pit_id = ?, scan_time_utc = ?, latitude = ?, longitude = ?, accuracy = ? WHERE colony_id = ? AND location_name = ?")
            ->execute([$tagNumber, $scanTime, $latitude, $longitude, $accuracy, $colonyId, $boxId]);
        $audit['pit_id'] = ['old' => $oldRow['pit_id'] ?? null, 'new' => $tagNumber];
    } else {
        // Location-only update — preserve any existing pit_id
        $pdo->prepare("UPDATE observation_locations SET scan_time_utc = ?, latitude = ?, longitude = ?, accuracy = ? WHERE colony_id = ? AND location_name = ?")
            ->execute([$scanTime, $latitude, $longitude, $accuracy, $colonyId, $boxId]);
    }

    auditBoxTag($pdo, 'UPDATE', $boxId, $audit);

    echo json_encode(['success' => true, 'message' => 'Box tag saved', 'box_id' => $boxId]);
}

function handleDelete($pdo, $colonyId) {
    $boxId = $_GET['box_id'] ?? null;
    if (!$boxId) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'box_id parameter required']); return; }

    // Get old values for audit
    $old = $pdo->prepare("SELECT location_id, pit_id, scan_time_utc, latitude, longitude, accuracy FROM observation_locations WHERE colony_id = ? AND location_name = ?");
    $old->execute([$colonyId, $boxId]);
    $oldRow = $old->fetch();

    // Clear the tag only — keep the stored location (lat/long/accuracy)
    $stmt = $pdo->prepare("UPDATE observation_locations SET pit_id = NULL WHERE colony_id = ? AND location_name = ?");
    $stmt->execute([$colonyId, $boxId]);

    if ($stmt->rowCount() > 0) {
        auditBoxTag($pdo, 'DELETE', $boxId, [
            'pit_id' => ['old' => $oldRow['pit_id'] ?? null, 'new' => null],
            'source' => 'boxtags_api',
        ]);
        echo json_encode(['success' => true, 'message' => 'Box tag cleared', 'box_id' => $boxId]);
    } else {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Box not found']);
    }
}

function formatBoxTag($row) {
    return [
        'BoxID' => $row['location_name'],
        'TagNumber' => $row['pit_id'] ?? '',
        'ScanTimeUTC' => $row['scan_time_utc'] ? date('c', strtotime($row['scan_time_utc'])) : date('c'),
        'Latitude' => $row['latitude'] !== null ? (float)$row['latitude'] : 0,
        'Longitude' => $row['longitude'] !== null ? (float)$row['longitude'] : 0,
        'Accuracy' => $row['accuracy'] !== null ? (float)$row['accuracy'] : -1
    ];
}
