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
    // Clearing a tag was audited against observer 0; the authenticated observer is right here.
    case 'DELETE': handleDelete($pdo, $colonyId, $observer['observer_id'] ?? 0); break;
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

    $pdo->beginTransaction();
    try {
        $sel = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
        $sel->execute([$colonyId, $boxId]);
        $locationId = $sel->fetchColumn();
        if ($locationId === false) {
            $locationId = wwAuditedInsert($pdo, 'observation_locations',
                ['colony_id' => $colonyId, 'location_name' => $boxId, 'location_type' => 'box'], $observerId, 'nestcheck_app');
        }

        // A null tag number means a location-only update — leave any existing pit_id alone.
        $fields = ['scan_time_utc' => $scanTime, 'latitude' => $latitude, 'longitude' => $longitude, 'accuracy' => $accuracy];
        if ($tagNumber !== null) $fields['pit_id'] = $tagNumber;
        wwAuditedUpdate($pdo, 'observation_locations', $locationId, $fields, $observerId, 'nestcheck_app');
        $pdo->commit();
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(500); echo json_encode(['success' => false, 'error' => $e->getMessage()]); return; }

    echo json_encode(['success' => true, 'message' => 'Box tag saved', 'box_id' => $boxId]);
}

function handleDelete($pdo, $colonyId, $observerId) {
    $boxId = $_GET['box_id'] ?? null;
    if (!$boxId) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'box_id parameter required']); return; }

    // Get old values for audit
    $old = $pdo->prepare("SELECT location_id, pit_id, scan_time_utc, latitude, longitude, accuracy FROM observation_locations WHERE colony_id = ? AND location_name = ?");
    $old->execute([$colonyId, $boxId]);
    $oldRow = $old->fetch();

    // Clear the tag only — keep the stored location (lat/long/accuracy). Audited as an UPDATE
    // (pit_id -> null), which is what it is; the location row itself survives.
    $cleared = $oldRow
        ? wwAuditedUpdate($pdo, 'observation_locations', $oldRow['location_id'], ['pit_id' => null], $observerId, 'boxtags_api')
        : 0;

    if ($cleared > 0) {
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
