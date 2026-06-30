<?php
/**
 * Admin API: user management + monitor sync
 * All actions require admin role.
 *
 * GET  ?action=users           - list all observers
 * POST ?action=update_user     - update observer {observer_id, role, observer_name, email}
 * POST ?action=sync_monitors   - pull latest from old TCP server and import
 */
require_once 'config.php';
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();

// Auth (header or query param for downloads)
$header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
    if (!empty($_GET['token'])) { $m = [null, $_GET['token']]; }
    else { http_response_code(401); echo json_encode(['error'=>'Auth required']); exit; }
}
$stmt = $pdo->prepare("SELECT o.* FROM sessions s JOIN observers o ON s.observer_id = o.observer_id WHERE s.token = ? AND s.expires_at > NOW()");
$stmt->execute([$m[1]]);
$observer = $stmt->fetch();
if (!$observer) { http_response_code(401); echo json_encode(['error'=>'Invalid token']); exit; }
if (($observer['role'] ?? '') !== 'admin') { http_response_code(403); echo json_encode(['error'=>'Admin required']); exit; }

$action = $_GET['action'] ?? '';

if ($action === 'duplicate_scans') {
    // Duplicates by pit_id
    $byPit = $pdo->query("
        SELECT ps.observation_id, ps.pit_id, COUNT(*) as cnt, MIN(ps.scan_id) as keep_id,
            ol.location_name as box_name, pc.peng_num,
            DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) as obs_date,
            'pit_id' as dup_type
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        LEFT JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 1
        WHERE (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
        GROUP BY ps.observation_id, ps.pit_id
        HAVING cnt > 1
    ")->fetchAll();

    // Duplicates by peng_num (different pit_ids mapping to same penguin — exclude exact dups already found)
    $byPeng = $pdo->query("
        SELECT ps.observation_id, pc.peng_num, COUNT(*) as cnt, MIN(ps.scan_id) as keep_id,
            ol.location_name as box_name,
            DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) as obs_date,
            GROUP_CONCAT(DISTINCT ps.pit_id) as pit_ids,
            'peng_num' as dup_type
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 1
        WHERE (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
        GROUP BY ps.observation_id, pc.peng_num
        HAVING cnt > 1 AND COUNT(DISTINCT ps.pit_id) > 1
    ")->fetchAll();

    echo json_encode(array_merge($byPit, $byPeng));
    exit;
}

// NOTE: cleanup_duplicate_scans was intentionally removed. Duplicate scans are
// preserved as evidence of data-entry errors and must not be bulk-deleted.

if ($action === 'same_gender_conflicts') {
    // Find observations where 2+ penguins of the same sex were scanned at the same box on the same day
    $stmt = $pdo->query("
        SELECT ol.location_name AS box_name,
            DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) AS obs_date,
            p.sex,
            COUNT(DISTINCT pc.peng_num) AS cnt,
            GROUP_CONCAT(DISTINCT pc.peng_num ORDER BY pc.peng_num) AS peng_nums
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 1
        JOIN penguins p ON pc.peng_num = p.peng_num
        WHERE o.is_deleted = FALSE
          AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
          AND p.sex IS NOT NULL AND p.sex != ''
        GROUP BY ol.location_name, DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')), p.sex
        HAVING cnt > 1
        ORDER BY obs_date DESC, ol.location_name + 0
    ");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'duplicate_observations') {
    $stmt = $pdo->query("
        SELECT ol.location_name as box_name,
            DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) as obs_date,
            COUNT(*) as cnt,
            GROUP_CONCAT(o.observation_id ORDER BY o.observation_time_utc DESC) as obs_ids,
            GROUP_CONCAT(COALESCE(ob.observer_name,'?') ORDER BY o.observation_time_utc DESC) as observers
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        LEFT JOIN observers ob ON o.observer_id = ob.observer_id
        WHERE o.is_deleted = FALSE
        GROUP BY ol.location_name, DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))
        HAVING cnt > 1
        ORDER BY obs_date DESC, ol.location_name + 0
    ");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'cleanup_duplicate_observations') {
    // Keep the most recent observation per box per day, soft-delete the rest
    $stmt = $pdo->query("
        SELECT ol.location_name as box_name, o.location_id,
            DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) as obs_date,
            MAX(o.observation_id) as keep_id
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE o.is_deleted = FALSE
        GROUP BY o.location_id, DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))
        HAVING COUNT(*) > 1
    ");
    $groups = $stmt->fetchAll();
    $deleted = 0;
    foreach ($groups as $g) {
        $del = $pdo->prepare("UPDATE observations SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE location_id = ? AND is_deleted = FALSE AND DATE(CONVERT_TZ(observation_time_utc, '+00:00', '+12:00')) = ? AND observation_id != ?");
        $del->execute([$observer['observer_id'], $g['location_id'], $g['obs_date'], $g['keep_id']]);
        $count = $del->rowCount();
        // Also soft-delete scans/biometrics for those observations
        if ($count > 0) {
            $pdo->prepare("UPDATE penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id SET ps.is_deleted = TRUE, ps.deleted_at = NOW(), ps.deleted_by = ? WHERE o.location_id = ? AND o.is_deleted = TRUE AND o.deleted_by = ? AND DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) = ? AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)")
                ->execute([$observer['observer_id'], $g['location_id'], $observer['observer_id'], $g['obs_date']]);
        }
        $deleted += $count;
    }
    echo json_encode(['duplicate_groups' => count($groups), 'observations_deleted' => $deleted]);
    exit;
}

if ($action === 'recent_changes') {
    $days = min(30, max(1, (int)($_GET['days'] ?? 7)));
    $stmt = $pdo->prepare("SELECT a.*,
        o.observer_name,
        DATE(CONVERT_TZ(a.change_timestamp, '+00:00', '+12:00')) as nz_date,
        CASE WHEN a.table_name = 'observations' THEN
            (SELECT ol.location_name FROM observations obs JOIN observation_locations ol ON obs.location_id = ol.location_id WHERE obs.observation_id = a.record_id LIMIT 1)
        END as box_name
        FROM audit_log a
        LEFT JOIN observers o ON a.observer_id = o.observer_id
        WHERE a.change_timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY a.change_timestamp DESC");
    $stmt->execute([$days]);
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'users') {
    $stmt = $pdo->query("SELECT observer_id, observer_name, email, role, created_at FROM observers ORDER BY observer_id");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'update_user') {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !$input['observer_id']) { http_response_code(400); echo json_encode(['error'=>'observer_id required']); exit; }
    $sets = []; $params = [];
    foreach (['role', 'observer_name', 'email'] as $field) {
        if (isset($input[$field])) { $sets[] = "$field = ?"; $params[] = $input[$field]; }
    }
    if (empty($sets)) { echo json_encode(['success'=>true]); exit; }
    $targetId = $input['observer_id'];
    // Get old values for audit
    $oldStmt = $pdo->prepare("SELECT role, observer_name, email FROM observers WHERE observer_id = ?");
    $oldStmt->execute([$targetId]);
    $oldRow = $oldStmt->fetch();
    $params[] = $targetId;
    $pdo->prepare("UPDATE observers SET " . implode(', ', $sets) . " WHERE observer_id = ?")->execute($params);
    $changed = [];
    foreach (['role', 'observer_name', 'email'] as $field) {
        if (isset($input[$field]) && ($oldRow[$field] ?? null) != $input[$field])
            $changed[$field] = ['old' => $oldRow[$field] ?? null, 'new' => $input[$field]];
    }
    if (!empty($changed)) {
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observers', ?, 'UPDATE', ?, ?)")
            ->execute([$targetId, $observer['observer_id'], json_encode($changed)]);
    }
    echo json_encode(['success'=>true]);
    exit;
}

// Preview or delete observations from a specific date
if ($action === 'preview_date' || $action === 'delete_date') {
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $date = $body['date'] ?? $_POST['date'] ?? $_GET['date'] ?? '';
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) { echo json_encode(['error' => 'date required (YYYY-MM-DD)']); exit; }

    $colonyId = 1;
    $utcStart = date('Y-m-d 11:00:00', strtotime($date) - 86400);
    $utcEnd = date('Y-m-d 12:00:00', strtotime($date));

    $stmt = $pdo->prepare("SELECT o.observation_id, o.observation_time_utc, o.adults, o.eggs, o.chicks,
        o.breeding_status, o.notes, o.monitor_filename, ol.location_name AS box_name,
        (SELECT COUNT(*) FROM penguin_scans ps WHERE ps.observation_id = o.observation_id AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)) as scan_count
        FROM observations o JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE o.observation_time_utc >= ? AND o.observation_time_utc < ? AND o.is_deleted = FALSE
        ORDER BY ol.location_name + 0");
    $stmt->execute([$utcStart, $utcEnd]);
    $observations = $stmt->fetchAll();

    $totals = ['boxes' => count($observations), 'adults' => 0, 'eggs' => 0, 'chicks' => 0, 'scans' => 0,
        'with_breeding' => 0, 'without_breeding' => 0];
    foreach ($observations as $o) {
        $totals['adults'] += (int)$o['adults'];
        $totals['eggs'] += (int)$o['eggs'];
        $totals['chicks'] += (int)$o['chicks'];
        $totals['scans'] += (int)$o['scan_count'];
        if (!empty($o['breeding_status'])) $totals['with_breeding']++;
        else $totals['without_breeding']++;
    }

    if ($action === 'preview_date') {
        echo json_encode(['date' => $date, 'totals' => $totals, 'observations' => $observations]);
        exit;
    }

    // Soft delete with audit
    $reason = $body['_reason'] ?? null;

    $pdo->beginTransaction();
    try {
        $obsIds = array_column($observations, 'observation_id');
        $deleted = 0;
        $oid = $observer['observer_id'];
        foreach ($obsIds as $obsId) {
            $pdo->prepare("UPDATE observations SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")
                ->execute([$oid, $obsId]);
            $pdo->prepare("UPDATE penguin_scans SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")
                ->execute([$oid, $obsId]);
            $pdo->prepare("UPDATE penguin_biometric_data SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")
                ->execute([$oid, $obsId]);
            $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields, change_reason) VALUES (?, ?, 'DELETE', ?, ?, ?)")
                ->execute(['observations', $obsId, $oid, json_encode(['date' => $date, 'bulk_delete' => true]), $reason]);
            $deleted++;
        }
        $pdo->commit();
        echo json_encode(['success' => true, 'deleted' => $deleted, 'date' => $date]);
    } catch (Exception $e) {
        $pdo->rollBack();
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

// Re-sync a specific monitor: delete its observations and re-import from TCP
// List monitor filenames that have data on a given NZ date
// Preview or delete all data from a specific monitor filename
// Shared: fetch monitors from TCP server
function fetchTcpMonitors() {
    $host = '210.54.37.120'; $port = 8080; $passphrase = 'bbnmdsfhsecureafdgsadsadff';
    $sock = @fsockopen($host, $port, $errno, $errstr, 5);
    if (!$sock) throw new Exception("Cannot connect: $errstr");
    stream_set_timeout($sock, 10);
    $rsa = openssl_pkey_new(['private_key_bits'=>1024, 'private_key_type'=>OPENSSL_KEYTYPE_RSA]);
    $details = openssl_pkey_get_details($rsa);
    fwrite($sock, base64_encode($details['rsa']['n']) . "\r\n");
    fwrite($sock, base64_encode($details['rsa']['e']) . "\r\n");
    $encKey = base64_decode(trim(fgets($sock))); $encIv = base64_decode(trim(fgets($sock)));
    openssl_private_decrypt($encKey, $aesKey, $rsa); openssl_private_decrypt($encIv, $aesIv, $rsa);
    $passBytes = mb_convert_encoding($passphrase, 'UTF-16LE', 'UTF-8');
    fwrite($sock, base64_encode(openssl_encrypt($passBytes, 'aes-256-cbc', $aesKey, OPENSSL_RAW_DATA, $aesIv)) . "\r\n");
    $qBytes = mb_convert_encoding('PenguinRequest-Saved:', 'UTF-16LE', 'UTF-8');
    fwrite($sock, base64_encode(openssl_encrypt($qBytes, 'aes-256-cbc', $aesKey, OPENSSL_RAW_DATA, $aesIv)) . "\r\n");
    $encResp = base64_decode(trim(fgets($sock, 1048576 * 4))); fclose($sock);
    $decResp = openssl_decrypt($encResp, 'aes-256-cbc', $aesKey, OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, $aesIv);
    $decResp = substr($decResp, 0, -ord($decResp[strlen($decResp) - 1]));
    $reply = mb_convert_encoding($decResp, 'UTF-8', 'UTF-16LE');
    $monitors = [];
    foreach (explode('~~~~', $reply) as $part) { $part = trim($part); if ($part && ($m = json_decode($part, true))) $monitors[] = $m; }
    usort($monitors, function($a, $b) { return strcmp($b['LastSaved'] ?? '', $a['LastSaved'] ?? ''); });
    return $monitors;
}

// Shared: summarise a monitor and check import status
function summariseMonitor($pdo, $monitor, $colonyId = 1, $observerId = 1) {
    $filename = $monitor['filename'] ?? 'unknown';
    $lastSaved = $monitor['LastSaved'] ?? null;
    $boxCount = count($monitor['BoxData'] ?? []);
    if ($monitor['IsDeleted'] ?? false) {
        // Check if data from this monitor still exists in our DB
        $dbCheck = $pdo->prepare("SELECT COUNT(*) FROM observations WHERE monitor_filename = ? AND is_deleted = FALSE");
        $dbCheck->execute([$filename]);
        $dbCount = (int)$dbCheck->fetchColumn();
        return ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'status'=>'deleted', 'db_exists'=>$dbCount, 'scans'=>0, 'adults'=>0, 'eggs'=>0, 'chicks'=>0, 'breeding_statuses'=>[]];
    }

    $adults = 0; $eggs = 0; $chicks = 0; $scans = 0; $new = 0; $exists = 0;
    $breedingCounts = [];
    foreach ($monitor['BoxData'] ?? [] as $boxName => $boxData) {
        $adults += (int)($boxData['Adults'] ?? 0); $eggs += (int)($boxData['Eggs'] ?? 0); $chicks += (int)($boxData['Chicks'] ?? 0);
        $scans += count($boxData['ScannedIds'] ?? []);
        $bc = $boxData['BreedingChance'] ?? ''; $key = ($bc === '' || $bc === null) ? '(empty)' : $bc;
        $breedingCounts[$key] = ($breedingCounts[$key] ?? 0) + 1;

        $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
        $stmt->execute([$colonyId, $boxName]); $locId = $stmt->fetchColumn();
        if ($locId) {
            $obsTime = date('Y-m-d H:i:s', strtotime($boxData['whenDataCollectedUtc'] ?? $lastSaved ?? 'now'));
            $dup = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND observer_id = ? AND is_deleted = FALSE");
            $dup->execute([$locId, $obsTime, $observerId]);
            if ($dup->fetchColumn()) $exists++; else $new++;
        } else { $new++; }
    }
    $status = $new > 0 ? 'new' : ($exists > 0 ? 'exists' : 'empty');
    return ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'new'=>$new, 'exists'=>$exists, 'status'=>$status, 'scans'=>$scans, 'adults'=>$adults, 'eggs'=>$eggs, 'chicks'=>$chicks, 'breeding_statuses'=>$breedingCounts];
}

// Shared: import one monitor
function importMonitor($pdo, $monitor, $colonyId = 1, $observerId = 1) {
    $chipLookup = [];
    foreach ($pdo->query("SELECT pit_id FROM penguin_chips")->fetchAll() as $c)
        $chipLookup[strtoupper(substr($c['pit_id'], -8))] = $c['pit_id'];

    $filename = $monitor['filename'] ?? 'unknown';
    $imported = 0; $skipped = 0; $scans = 0;
    foreach ($monitor['BoxData'] ?? [] as $boxName => $boxData) {
        $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")->execute([$colonyId, $boxName]);
        $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
        $stmt->execute([$colonyId, $boxName]); $locationId = $stmt->fetchColumn();
        if (!$locationId) continue;

        $obsTime = date('Y-m-d H:i:s', strtotime($boxData['whenDataCollectedUtc'] ?? $monitor['LastSaved'] ?? 'now'));
        $dup = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND observer_id = ? AND is_deleted = FALSE");
        $dup->execute([$locationId, $obsTime, $observerId]);
        if ($dup->fetchColumn()) { $skipped++; continue; }

        $stmt = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)");
        $stmt->execute([$locationId, $observerId, $obsTime,
            $boxData['Adults'] ?? 0, $boxData['Eggs'] ?? 0, $boxData['Chicks'] ?? 0,
            !empty($boxData['BreedingChance']) ? $boxData['BreedingChance'] : null,
            !empty($boxData['GateStatus']) ? $boxData['GateStatus'] : null,
            $boxData['Notes'] ?? '', $filename]);
        $observationId = $pdo->lastInsertId();
        $imported++;

        foreach ($boxData['ScannedIds'] ?? [] as $scan) {
            $birdId = $scan['BirdId'] ?? ''; if (empty($birdId)) continue;
            $short8 = strtoupper(substr(preg_replace('/[^A-Za-z0-9]/', '', $birdId), -8));
            if (substr($short8, 0, 4) === '9130') continue;
            if (isset($chipLookup[$short8])) {
                $scanTime = $scan['Timestamp'] ?? $obsTime;
                $lat = isset($scan['Latitude']) && $scan['Latitude'] != 0 ? $scan['Latitude'] : null;
                $lon = isset($scan['Longitude']) && $scan['Longitude'] != 0 ? $scan['Longitude'] : null;
                $acc = isset($scan['Accuracy']) && $scan['Accuracy'] > 0 ? $scan['Accuracy'] : null;
                $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc, latitude, longitude, accuracy) VALUES (?,?,?,?,?,?)")
                    ->execute([$observationId, $chipLookup[$short8], date('Y-m-d H:i:s', strtotime($scanTime)), $lat, $lon, $acc]);
                $scans++;

                // Update box GPS if null or >50% more accurate
                if ($lat && $lon && $acc) {
                    $pdo->prepare("UPDATE observation_locations SET latitude = ?, longitude = ?, accuracy = ?, scan_time_utc = ?
                        WHERE location_id = ? AND (latitude IS NULL OR accuracy > ? * 2)")
                        ->execute([$lat, $lon, $acc, date('Y-m-d H:i:s', strtotime($scanTime)), $locationId, $acc]);
                }
            }
        }
    }
    return ['imported'=>$imported, 'skipped'=>$skipped, 'scans'=>$scans];
}

// Query TCP server — fetch, cache, return summaries
if ($action === 'query_server') {
    try {
        $monitors = fetchTcpMonitors();
        // Cache for subsequent import_monitor calls
        $cachePath = sys_get_temp_dir() . '/ww_tcp_cache_' . $observer['observer_id'] . '.json';
        file_put_contents($cachePath, json_encode($monitors));

        $results = [];
        foreach ($monitors as $i => $m) {
            $summary = summariseMonitor($pdo, $m);
            $summary['index'] = $i;
            $results[] = $summary;
        }
        echo json_encode(['success'=>true, 'monitors'=>$results]);
    } catch (Exception $e) { echo json_encode(['error'=>$e->getMessage()]); }
    exit;
}

// Import a single monitor by index from cache
if ($action === 'import_monitor') {
    $index = (int)($_POST['index'] ?? json_decode(file_get_contents('php://input'), true)['index'] ?? -1);
    $cachePath = sys_get_temp_dir() . '/ww_tcp_cache_' . $observer['observer_id'] . '.json';
    if (!file_exists($cachePath)) { echo json_encode(['error'=>'No cached data. Query server first.']); exit; }
    $monitors = json_decode(file_get_contents($cachePath), true);
    if (!isset($monitors[$index])) { echo json_encode(['error'=>"Monitor index $index not found"]); exit; }
    $result = importMonitor($pdo, $monitors[$index]);
    echo json_encode(['success'=>true, ...$result, 'filename'=>$monitors[$index]['filename'] ?? 'unknown']);
    exit;
}

// Legacy sync (import all) and trial

if ($action === 'export_nestcheck_zip') {
    $colonyId = $_GET['colony'] ?? 1;

    // Get all observation dates (NZ time)
    $stmt = $pdo->prepare("
        SELECT DISTINCT DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) AS obs_date
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND o.is_deleted = FALSE
        ORDER BY obs_date
    ");
    $stmt->execute([$colonyId]);
    $dates = $stmt->fetchAll(PDO::FETCH_COLUMN);

    // Build a MonitorDetails JSON for each date
    $tmpFile = tempnam(sys_get_temp_dir(), 'nestcheck_export_');
    $zip = new ZipArchive();
    $zip->open($tmpFile, ZipArchive::CREATE | ZipArchive::OVERWRITE);

    foreach ($dates as $date) {
        $stmt = $pdo->prepare("
            SELECT ol.location_name AS box_name,
                o.observation_time_utc, o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes,
                o.observation_id
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE
              AND DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) = ?
            ORDER BY ol.location_name + 0, ol.location_name
        ");
        $stmt->execute([$colonyId, $date]);
        $obs = $stmt->fetchAll();

        $boxData = [];
        foreach ($obs as $row) {
            $scans = $pdo->prepare("SELECT pit_id, scan_time_utc, latitude, longitude, accuracy FROM penguin_scans WHERE observation_id = ? AND (is_deleted = FALSE OR is_deleted IS NULL)");
            $scans->execute([$row['observation_id']]);
            $scanRecords = [];
            foreach ($scans->fetchAll() as $scan) {
                $scanRecords[] = [
                    'BirdId' => $scan['pit_id'],
                    'Timestamp' => $scan['scan_time_utc'] ? date('c', strtotime($scan['scan_time_utc'])) : date('c'),
                    'Latitude' => (float)($scan['latitude'] ?? 0),
                    'Longitude' => (float)($scan['longitude'] ?? 0),
                    'Accuracy' => (float)($scan['accuracy'] ?? 0),
                ];
            }
            $boxData[$row['box_name']] = [
                'ScannedIds' => $scanRecords,
                'Adults' => (int)$row['adults'],
                'Eggs' => (int)$row['eggs'],
                'Chicks' => (int)$row['chicks'],
                'GateStatus' => $row['gate_status'],
                'Notes' => $row['notes'] ?? '',
                'whenDataCollectedUtc' => date('c', strtotime($row['observation_time_utc'])),
                'BreedingChance' => $row['breeding_status'],
            ];
        }

        $nzDate = date('d M Y', strtotime($date));
        $monitor = [
            'LastSaved' => date('c', strtotime($date . ' 23:59:59')),
            'filename' => "PenguinMonitor $nzDate",
            'BoxData' => (object)$boxData,
        ];

        $json = json_encode($monitor, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        $zip->addFromString("Nestcheck $date.json", $json);
    }

    $zip->close();

    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="nestcheck-export-' . date('Y-m-d') . '.zip"');
    header('Content-Length: ' . filesize($tmpFile));
    header_remove('Access-Control-Allow-Origin');
    readfile($tmpFile);
    unlink($tmpFile);
    exit;
}

// --- Remove Penguin ---

if ($action === 'preview_penguin_delete') {
    $pengNum = $_GET['peng_num'] ?? '';
    if (!$pengNum) { http_response_code(400); echo json_encode(['error' => 'peng_num required']); exit; }

    $peng = $pdo->prepare("SELECT * FROM penguins WHERE peng_num = ?");
    $peng->execute([$pengNum]);
    $penguin = $peng->fetch();
    if (!$penguin) { http_response_code(404); echo json_encode(['error' => 'Penguin not found']); exit; }

    $chips = $pdo->prepare("SELECT * FROM penguin_chips WHERE peng_num = ?");
    $chips->execute([$pengNum]);
    $chipList = $chips->fetchAll();

    $pitIds = array_column($chipList, 'pit_id');
    $scans = [];
    if (!empty($pitIds)) {
        $ph = implode(',', array_fill(0, count($pitIds), '?'));
        $scanStmt = $pdo->prepare("SELECT ps.*, o.observation_time_utc, ol.location_name AS box_name
            FROM penguin_scans ps
            JOIN observations o ON ps.observation_id = o.observation_id
            JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ps.pit_id IN ($ph) AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
            ORDER BY o.observation_time_utc DESC");
        $scanStmt->execute($pitIds);
        $scans = $scanStmt->fetchAll();
    }

    $bio = $pdo->prepare("SELECT * FROM penguin_biometric_data WHERE peng_num = ? AND (is_deleted = FALSE OR is_deleted IS NULL)");
    $bio->execute([$pengNum]);
    $bioData = $bio->fetchAll();

    echo json_encode([
        'penguin' => $penguin,
        'chips' => $chipList,
        'scans' => $scans,
        'biometrics' => $bioData,
        'scan_count' => count($scans),
    ]);
    exit;
}

if ($action === 'delete_penguin') {
    $input = json_decode(file_get_contents('php://input'), true);
    $pengNum = $input['peng_num'] ?? '';
    if (!$pengNum) { http_response_code(400); echo json_encode(['error' => 'peng_num required']); exit; }

    $pdo->beginTransaction();
    try {
        $oid = $observer['observer_id'];

        // Get pit_ids for this penguin
        $chips = $pdo->prepare("SELECT pit_id FROM penguin_chips WHERE peng_num = ?");
        $chips->execute([$pengNum]);
        $pitIds = array_column($chips->fetchAll(), 'pit_id');

        // Soft-delete scans
        $scansDeleted = 0;
        if (!empty($pitIds)) {
            $ph = implode(',', array_fill(0, count($pitIds), '?'));
            $countStmt = $pdo->prepare("SELECT COUNT(*) FROM penguin_scans WHERE pit_id IN ($ph)");
            $countStmt->execute($pitIds);
            $scansDeleted = (int)$countStmt->fetchColumn();
            $pdo->prepare("DELETE FROM penguin_scans WHERE pit_id IN ($ph)")->execute($pitIds);
        }

        // Delete biometrics
        $pdo->prepare("DELETE FROM penguin_biometric_data WHERE peng_num = ?")->execute([$pengNum]);

        // Delete chips
        $pdo->prepare("DELETE FROM penguin_chips WHERE peng_num = ?")->execute([$pengNum]);

        // Delete penguin
        $pdo->prepare("DELETE FROM penguins WHERE peng_num = ?")->execute([$pengNum]);

        // Audit
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields, change_reason) VALUES ('penguins', ?, 'DELETE', ?, ?, ?)")
            ->execute([$pengNum, $oid, json_encode(['peng_num' => $pengNum, 'pit_ids' => $pitIds, 'scans_deleted' => $scansDeleted]), $input['reason'] ?? 'Admin delete']);

        $pdo->commit();
        echo json_encode(['success' => true, 'scans_deleted' => $scansDeleted, 'chips_deleted' => count($pitIds)]);
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

// --- Regions & Colonies management ---

if ($action === 'regions') {
    $stmt = $pdo->query("SELECT r.*, (SELECT COUNT(*) FROM colonies c WHERE c.region_id = r.region_id) as colony_count FROM regions r ORDER BY r.region_name");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'save_region') {
    $input = json_decode(file_get_contents('php://input'), true);
    $name = trim($input['region_name'] ?? '');
    if (!$name) { http_response_code(400); echo json_encode(['error' => 'region_name required']); exit; }
    $id = $input['region_id'] ?? null;
    if ($id) {
        $pdo->prepare("UPDATE regions SET region_name = ? WHERE region_id = ?")->execute([$name, $id]);
    } else {
        $pdo->prepare("INSERT INTO regions (region_name) VALUES (?)")->execute([$name]);
        $id = $pdo->lastInsertId();
    }
    echo json_encode(['success' => true, 'region_id' => (int)$id]);
    exit;
}

if ($action === 'colonies') {
    $stmt = $pdo->query("SELECT c.*, r.region_name FROM colonies c JOIN regions r ON c.region_id = r.region_id ORDER BY r.region_name, c.colony_name");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'save_colony') {
    $input = json_decode(file_get_contents('php://input'), true);
    $name = trim($input['colony_name'] ?? '');
    $regionId = (int)($input['region_id'] ?? 0);
    $locationSets = trim($input['location_sets_string'] ?? '');
    if (!$name || !$regionId) { http_response_code(400); echo json_encode(['error' => 'colony_name and region_id required']); exit; }
    $id = $input['colony_id'] ?? null;
    if ($id) {
        $pdo->prepare("UPDATE colonies SET colony_name = ?, region_id = ?, location_sets_string = ? WHERE colony_id = ?")
            ->execute([$name, $regionId, $locationSets, $id]);
    } else {
        $pdo->prepare("INSERT INTO colonies (colony_name, region_id, location_sets_string) VALUES (?, ?, ?)")
            ->execute([$name, $regionId, $locationSets]);
        $id = $pdo->lastInsertId();
    }
    echo json_encode(['success' => true, 'colony_id' => (int)$id]);
    exit;
}

if ($action === 'colony_box_names') {
    $colonyId = (int)($_GET['colony_id'] ?? 0);
    if (!$colonyId) { echo json_encode([]); exit; }
    $stmt = $pdo->prepare("SELECT location_name FROM observation_locations WHERE colony_id = ?");
    $stmt->execute([$colonyId]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
    exit;
}

if ($action === 'create_colony_boxes') {
    // Materialise a colony's box-sets into observation_locations rows. Idempotent:
    // existing (colony_id, location_name) are kept via INSERT IGNORE.
    $input = json_decode(file_get_contents('php://input'), true);
    $colonyId = (int)($input['colony_id'] ?? 0);
    $names = $input['box_names'] ?? [];
    if (!$colonyId || !is_array($names) || empty($names)) { http_response_code(400); echo json_encode(['error' => 'colony_id and box_names required']); exit; }
    $stmt = $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')");
    $created = 0;
    foreach ($names as $name) {
        $name = trim((string)$name);
        if ($name === '') continue;
        $stmt->execute([$colonyId, $name]);
        $created += $stmt->rowCount();
    }
    echo json_encode(['success' => true, 'created' => $created, 'requested' => count($names)]);
    exit;
}

if ($action === 'colony_permissions') {
    $stmt = $pdo->query("SELECT cp.permission_id, cp.colony_id, cp.observer_id, cp.role,
            c.colony_name, o.observer_name
        FROM colony_permissions cp
        JOIN colonies c ON cp.colony_id = c.colony_id
        JOIN observers o ON cp.observer_id = o.observer_id
        ORDER BY c.colony_name, o.observer_name");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'save_colony_permission') {
    // Grant/change/revoke a user's access to a colony. role 'view' | 'edit', or '' to revoke.
    $input = json_decode(file_get_contents('php://input'), true);
    $colonyId = (int)($input['colony_id'] ?? 0);
    $observerId = (int)($input['observer_id'] ?? 0);
    $role = trim($input['role'] ?? '');
    if (!$colonyId || !$observerId) { http_response_code(400); echo json_encode(['error' => 'colony_id and observer_id required']); exit; }

    if ($role === '' || $role === 'none') {
        $pdo->prepare("DELETE FROM colony_permissions WHERE colony_id = ? AND observer_id = ?")->execute([$colonyId, $observerId]);
        $logRole = '(revoked)';
    } else {
        if (!in_array($role, ['view', 'edit'], true)) { http_response_code(400); echo json_encode(['error' => "role must be 'view', 'edit', or empty to revoke"]); exit; }
        $pdo->prepare("INSERT INTO colony_permissions (colony_id, observer_id, role) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE role = VALUES(role)")->execute([$colonyId, $observerId, $role]);
        $logRole = $role;
    }
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('colony_permissions', ?, 'UPDATE', ?, ?)")
        ->execute([$observerId, $observer['observer_id'], json_encode(['colony_id' => $colonyId, 'observer_id' => $observerId, 'role' => $logRole])]);
    echo json_encode(['success' => true]);
    exit;
}

echo json_encode(['error'=>'Unknown action']);
