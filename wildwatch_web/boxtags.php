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
 * All requests require X-API-Key header
 */

require_once 'config.php';

setHeaders();
validateApiKey();

$method = $_SERVER['REQUEST_METHOD'];
$pdo = getDbConnection();
$colonyId = 1;

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
        if ($row && $row['pit_id']) {
            echo json_encode(['success' => true, 'data' => formatBoxTag($row)]);
        } else {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Box tag not found']);
        }
    } else {
        $stmt = $pdo->prepare("SELECT * FROM observation_locations WHERE colony_id = ? AND pit_id IS NOT NULL ORDER BY location_name + 0, location_name");
        $stmt->execute([$colonyId]);
        $data = [];
        foreach ($stmt->fetchAll() as $row) {
            $data[$row['location_name']] = formatBoxTag($row);
        }
        echo json_encode(['success' => true, 'data' => (object)$data, 'count' => count($data)]);
    }
}

function auditBoxTag($pdo, $action, $boxId, $changed) {
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observation_locations', ?, ?, 0, ?)")
        ->execute([$boxId, $action, json_encode($changed)]);
}

function handlePost($pdo, $colonyId) {
    // Disabled: box tag writes are managed server-side only
    echo json_encode(['success' => true, 'message' => 'Box tag sync disabled']);
    return;
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'Invalid JSON body']); return; }

    $boxId = $input['BoxID'] ?? $input['box_id'] ?? null;
    $tagNumber = $input['TagNumber'] ?? $input['tag_number'] ?? null;
    if (!$boxId || !$tagNumber) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'BoxID and TagNumber are required']); return; }

    $scanTime = date('Y-m-d H:i:s', strtotime($input['ScanTimeUTC'] ?? $input['scan_time_utc'] ?? 'now'));
    $latitude = $input['Latitude'] ?? $input['latitude'] ?? null;
    $longitude = $input['Longitude'] ?? $input['longitude'] ?? null;
    $accuracy = $input['Accuracy'] ?? $input['accuracy'] ?? null;

    // Get old value for audit
    $old = $pdo->prepare("SELECT pit_id, scan_time_utc FROM observation_locations WHERE colony_id = ? AND location_name = ?");
    $old->execute([$colonyId, $boxId]);
    $oldRow = $old->fetch();

    // Ensure location exists
    $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")->execute([$colonyId, $boxId]);

    // Update pit_id and scan time only — GPS is updated via TCP import
    $pdo->prepare("UPDATE observation_locations SET pit_id = ?, scan_time_utc = ? WHERE colony_id = ? AND location_name = ?")
        ->execute([$tagNumber, $scanTime, $colonyId, $boxId]);

    auditBoxTag($pdo, 'UPDATE', $boxId, [
        'pit_id' => ['old' => $oldRow['pit_id'] ?? null, 'new' => $tagNumber],
        'scan_time_utc' => ['old' => $oldRow['scan_time_utc'] ?? null, 'new' => $scanTime],
        'source' => 'boxtags_api',
    ]);

    echo json_encode(['success' => true, 'message' => 'Box tag saved', 'box_id' => $boxId]);
}

function handleDelete($pdo, $colonyId) {
    $boxId = $_GET['box_id'] ?? null;
    if (!$boxId) { http_response_code(400); echo json_encode(['success' => false, 'error' => 'box_id parameter required']); return; }

    // Get old values for audit
    $old = $pdo->prepare("SELECT location_id, pit_id, scan_time_utc, latitude, longitude, accuracy FROM observation_locations WHERE colony_id = ? AND location_name = ?");
    $old->execute([$colonyId, $boxId]);
    $oldRow = $old->fetch();

    $stmt = $pdo->prepare("UPDATE observation_locations SET pit_id = NULL, scan_time_utc = NULL, latitude = NULL, longitude = NULL, accuracy = NULL WHERE colony_id = ? AND location_name = ?");
    $stmt->execute([$colonyId, $boxId]);

    if ($stmt->rowCount() > 0) {
        auditBoxTag($pdo, 'DELETE', $boxId, [
            'pit_id' => ['old' => $oldRow['pit_id'] ?? null, 'new' => null],
            'scan_time_utc' => ['old' => $oldRow['scan_time_utc'] ?? null, 'new' => null],
            'latitude' => ['old' => $oldRow['latitude'] ?? null, 'new' => null],
            'longitude' => ['old' => $oldRow['longitude'] ?? null, 'new' => null],
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
        'TagNumber' => $row['pit_id'],
        'ScanTimeUTC' => $row['scan_time_utc'] ? date('c', strtotime($row['scan_time_utc'])) : date('c'),
        'Latitude' => $row['latitude'] !== null ? (float)$row['latitude'] : 0,
        'Longitude' => $row['longitude'] !== null ? (float)$row['longitude'] : 0,
        'Accuracy' => $row['accuracy'] !== null ? (float)$row['accuracy'] : -1
    ];
}
