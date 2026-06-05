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

// Auth
$header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
    http_response_code(401); echo json_encode(['error'=>'Auth required']); exit;
}
$stmt = $pdo->prepare("SELECT o.* FROM sessions s JOIN observers o ON s.observer_id = o.observer_id WHERE s.token = ? AND s.expires_at > NOW()");
$stmt->execute([$m[1]]);
$observer = $stmt->fetch();
if (!$observer) { http_response_code(401); echo json_encode(['error'=>'Invalid token']); exit; }
if (($observer['role'] ?? '') !== 'admin') { http_response_code(403); echo json_encode(['error'=>'Admin required']); exit; }

$action = $_GET['action'] ?? '';

if ($action === 'recent_changes') {
    $limit = min(100, max(10, (int)($_GET['limit'] ?? 50)));
    $stmt = $pdo->prepare("SELECT a.*, o.observer_name,
        CASE WHEN a.table_name = 'observations' THEN
            (SELECT ol.location_name FROM observations obs JOIN observation_locations ol ON obs.location_id = ol.location_id WHERE obs.observation_id = a.record_id LIMIT 1)
        END as box_name
        FROM audit_log a
        JOIN observers o ON a.observer_id = o.observer_id
        ORDER BY a.change_timestamp DESC LIMIT ?");
    $stmt->execute([$limit]);
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

if ($action === 'wipe_monitors') {
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    $del1 = $pdo->exec("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename NOT LIKE 'sheet-import%'");
    $del2 = $pdo->exec("DELETE FROM observations WHERE monitor_filename NOT LIKE 'sheet-import%'");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observations', 'bulk', 'DELETE', ?, ?)")
        ->execute([$observer['observer_id'], json_encode(['action'=>'wipe_monitors', 'deleted_scans'=>$del1, 'deleted_observations'=>$del2])]);
    echo json_encode(['success'=>true, 'deleted_scans'=>$del1, 'deleted_observations'=>$del2]);
    exit;
}

if ($action === 'wipe_sightings') {
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    $del1 = $pdo->exec("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename LIKE 'sheet-import%'");
    $del2 = $pdo->exec("DELETE bd FROM penguin_biometric_data bd JOIN observations o ON bd.observation_id = o.observation_id WHERE o.monitor_filename LIKE 'sheet-import%'");
    $del3 = $pdo->exec("DELETE FROM observations WHERE monitor_filename LIKE 'sheet-import%'");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observations', 'bulk', 'DELETE', ?, ?)")
        ->execute([$observer['observer_id'], json_encode(['action'=>'wipe_sightings', 'deleted_scans'=>$del1, 'deleted_biometrics'=>$del2, 'deleted_observations'=>$del3])]);
    echo json_encode(['success'=>true, 'deleted_scans'=>$del1, 'deleted_biometrics'=>$del2, 'deleted_observations'=>$del3]);
    exit;
}

if ($action === 'wipe_penguins') {
    $counts = [
        'penguins' => (int)$pdo->query("SELECT COUNT(*) FROM penguins")->fetchColumn(),
        'chips' => (int)$pdo->query("SELECT COUNT(*) FROM penguin_chips")->fetchColumn(),
        'scans' => (int)$pdo->query("SELECT COUNT(*) FROM penguin_scans")->fetchColumn(),
        'biometrics' => (int)$pdo->query("SELECT COUNT(*) FROM penguin_biometric_data")->fetchColumn(),
    ];
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    $pdo->exec("DELETE FROM penguin_scans");
    $pdo->exec("DELETE FROM penguin_biometric_data");
    $pdo->exec("DELETE FROM penguin_chips");
    $pdo->exec("DELETE FROM penguins");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('penguins', 'bulk', 'DELETE', ?, ?)")
        ->execute([$observer['observer_id'], json_encode(['action'=>'wipe_penguins', 'deleted'=>$counts])]);
    echo json_encode(['success'=>true, 'message'=>'All penguins, chips, scans and biometrics deleted']);
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
        (SELECT COUNT(*) FROM penguin_scans ps WHERE ps.observation_id = o.observation_id) as scan_count
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
        foreach ($obsIds as $oid) {
            $pdo->prepare("UPDATE observations SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")
                ->execute([$observer['observer_id'], $oid]);
            $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields, change_reason) VALUES (?, ?, 'DELETE', ?, ?, ?)")
                ->execute(['observations', $oid, $observer['observer_id'], json_encode(['date' => $date, 'bulk_delete' => true]), $reason]);
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
if ($action === 'resync_monitor') {
    $monitorName = $_POST['monitor'] ?? '';
    if (empty($monitorName)) { echo json_encode(['error' => 'monitor name required']); exit; }

    $pdo->beginTransaction();
    try {
        // Delete scans for this monitor's observations
        $del1 = $pdo->prepare("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename = ?");
        $del1->execute([$monitorName]);
        $scansDel = $del1->rowCount();

        // Delete the observations
        $del2 = $pdo->prepare("DELETE FROM observations WHERE monitor_filename = ?");
        $del2->execute([$monitorName]);
        $obsDel = $del2->rowCount();

        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observations', ?, 'DELETE', ?, ?)")
            ->execute([$monitorName, $observer['observer_id'], json_encode(['action'=>'resync_monitor', 'monitor'=>$monitorName, 'deleted_scans'=>$scansDel, 'deleted_observations'=>$obsDel])]);
        $pdo->commit();
        echo json_encode(['success' => true, 'deleted_scans' => $scansDel, 'deleted_observations' => $obsDel, 'message' => "Deleted $obsDel observations and $scansDel scans for '$monitorName'. Run Sync to re-import."]);
    } catch (Exception $e) {
        $pdo->rollBack();
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

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
    if ($monitor['IsDeleted'] ?? false)
        return ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'status'=>'deleted', 'scans'=>0, 'adults'=>0, 'eggs'=>0, 'chicks'=>0, 'breeding_statuses'=>[]];

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
if ($action === 'sync_monitors' || $action === 'trial_sync') {
    $dryRun = ($action === 'trial_sync');
    try { $monitors = fetchTcpMonitors(); } catch (Exception $e) { echo json_encode(['error'=>$e->getMessage()]); exit; }

    $chipLookup = [];
    foreach ($pdo->query("SELECT pit_id FROM penguin_chips")->fetchAll() as $c)
        $chipLookup[strtoupper(substr($c['pit_id'], -8))] = $c['pit_id'];

    $colonyId = 1; $observerId = 1; $monitorResults = [];
    foreach ($monitors as $monitor) {
        $summary = summariseMonitor($pdo, $monitor);
        if (!$dryRun && $summary['status'] === 'new') {
            $importResult = importMonitor($pdo, $monitor);
            $summary['status'] = 'imported';
            $summary['new'] = $importResult['imported'];
        }
        $monitorResults[] = $summary;
    }
    echo json_encode(['success'=>true, 'monitors'=>$monitorResults]);
    exit;
}

if ($action === 'import_penguins' || $action === 'trial_reimport_penguins') {
    $dryRun = ($action === 'trial_reimport_penguins');

    $csv = fetchGoogleSheet('406382921');
    if (!$csv) { echo json_encode(['error'=>'Google Sheets export failed']); exit; }

    $handle = fopen('php://temp', 'r+');
    fwrite($handle, $csv);
    rewind($handle);
    $header = fgetcsv($handle);
    $rows = [];
    while (($row = fgetcsv($handle)) !== false) $rows[] = $row;
    fclose($handle);

    // Count current state
    $currentPenguins = (int)$pdo->query("SELECT COUNT(*) FROM penguins")->fetchColumn();
    $currentChips = (int)$pdo->query("SELECT COUNT(*) FROM penguin_chips")->fetchColumn();

    $created = 0; $chipsCreated = 0; $rechips = 0; $skipped = 0;
    $chipDateIssues = [];

    // Compare chip dates: DB vs sheet BEFORE wiping
    $existingChips = [];
    foreach ($pdo->query("SELECT pit_id, peng_num, chip_date FROM penguin_chips")->fetchAll() as $c) {
        $existingChips[$c['pit_id']] = $c;
    }

    // Build what the sheet will create
    $sheetChips = [];
    foreach ($rows as $cols) {
        while (count($cols) < 40) $cols[] = '';
        $number = trim($cols[0]);
        if (empty($number) || !is_numeric($number)) continue;
        $fullChipId = trim($cols[1]);
        if (empty($fullChipId)) continue;
        $fullIsoRaw = trim($cols[37] ?? '');
        $reChipFlag = trim($cols[33] ?? '');
        if (!empty($reChipFlag) && !empty($fullIsoRaw)) {
            $sid = 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $fullChipId), 8, '0', STR_PAD_LEFT);
        } elseif (!empty($fullIsoRaw)) {
            $sid = 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw);
        } else {
            $sid = 'LA' . preg_replace('/[^0-9]/', '', $fullChipId);
        }
        $cd = trim($cols[2]);
        $pd = null;
        if (!empty($cd)) { $ts = strtotime($cd); if ($ts) $pd = date('Y-m-d', $ts); }
        $sheetChips[$sid] = ['peng_num'=>$number, 'chip_date'=>$pd];

        // Rechip
        $ac2 = trim($cols[35] ?? '');
        if (!empty($ac2) && !empty($reChipFlag)) {
            $rid = !empty($fullIsoRaw) ? 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw) : 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $ac2), 8, '0', STR_PAD_LEFT);
            $rcd = trim($cols[36] ?? '');
            $rpd = null;
            if (!empty($rcd)) { $ts = strtotime($rcd); if ($ts) $rpd = date('Y-m-d', $ts); }
            if ($rid !== $sid) $sheetChips[$rid] = ['peng_num'=>$number, 'chip_date'=>$rpd];
        }
    }

    // Find discrepancies
    foreach ($existingChips as $pitId => $db) {
        if (isset($sheetChips[$pitId])) {
            $sheet = $sheetChips[$pitId];
            if ($db['chip_date'] !== $sheet['chip_date']) {
                $chipDateIssues[] = ['type'=>'date_mismatch', 'pit_id'=>$pitId, 'peng_num'=>$db['peng_num'], 'db_date'=>$db['chip_date'], 'sheet_date'=>$sheet['chip_date']];
            }
        } else {
            $chipDateIssues[] = ['type'=>'in_db_not_sheet', 'pit_id'=>$pitId, 'peng_num'=>$db['peng_num'], 'db_date'=>$db['chip_date']];
        }
    }
    foreach ($sheetChips as $pitId => $sheet) {
        if (!isset($existingChips[$pitId])) {
            $chipDateIssues[] = ['type'=>'in_sheet_not_db', 'pit_id'=>$pitId, 'peng_num'=>$sheet['peng_num'], 'sheet_date'=>$sheet['chip_date']];
        }
    }

    // Wipe removed — use wipe_penguins action instead

    foreach ($rows as $cols) {
        while (count($cols) < 40) $cols[] = '';
        $number = trim($cols[0]);
        if (empty($number) || !is_numeric($number)) { $skipped++; continue; }
        $fullChipId = trim($cols[1]);
        if (empty($fullChipId)) { $skipped++; continue; }

        $fullIsoRaw = trim($cols[37] ?? '');
        $reChipFlag = trim($cols[33] ?? '');
        if (!empty($reChipFlag) && !empty($fullIsoRaw)) {
            $shortId = 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $fullChipId), 8, '0', STR_PAD_LEFT);
        } elseif (!empty($fullIsoRaw)) {
            $shortId = 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw);
        } else {
            $shortId = 'LA' . preg_replace('/[^0-9]/', '', $fullChipId);
        }
        if (strlen($shortId) < 4) { $skipped++; continue; }

        $chipDate = trim($cols[2]);
        $sex = trim($cols[3]);
        $vid = trim($cols[4]);
        $chipBox = trim($cols[6]);
        $lifeStage = trim($cols[12]);
        $chipBy = trim($cols[23]);
        $chipAs = trim($cols[24]);
        $chickSizeSex = trim($cols[31]);
        $rechipBy = trim($cols[34] ?? '');
        $activeChip2 = trim($cols[35] ?? '');
        $rechipDateRaw = trim($cols[36] ?? '');
        $solo = trim($cols[38] ?? '');
        $kommentar = trim($cols[39] ?? '');

        $parsedDate = null;
        if (!empty($chipDate)) { $ts = strtotime($chipDate); if ($ts) $parsedDate = date('Y-m-d', $ts); }
        $chippedAsAdult = 0;
        if (!empty($chipAs)) $chippedAsAdult = (stripos($chipAs, 'chick') === false) ? 1 : 0;
        $sexNorm = null;
        if (strtoupper($sex) === 'F' || stripos($sex, 'female') !== false) $sexNorm = 'F';
        elseif (strtoupper($sex) === 'M' || stripos($sex, 'male') !== false) $sexNorm = 'M';

        if (!$dryRun) {
            // Skip existing in additive mode
            if (!$wipe) {
                $exists = $pdo->prepare("SELECT 1 FROM penguins WHERE peng_num = ?");
                $exists->execute([$number]);
                if ($exists->fetchColumn()) { $skipped++; continue; }
            }
            $pdo->prepare("INSERT INTO penguins (peng_num, sex, chipped_as_adult, life_stage, vid_for_scanner, chick_size_code, kommentar) VALUES (?, ?, ?, ?, ?, ?, ?)")
                ->execute([$number, $sexNorm, $chippedAsAdult, $lifeStage ?: null, $vid ?: null, $chickSizeSex ?: null, $kommentar ?: null]);
        }
        $created++;

        $isActive = empty($reChipFlag) ? 1 : 0;
        if (!$dryRun) {
            $pdo->prepare("INSERT INTO penguin_chips (pit_id, peng_num, chip_date, is_active, chip_box, chip_by, solo) VALUES (?, ?, ?, ?, ?, ?, ?)")
                ->execute([$shortId, $number, $parsedDate, $isActive, $chipBox ?: null, $chipBy ?: null, $solo ?: null]);
        }
        $chipsCreated++;

        if (!empty($activeChip2) && !empty($reChipFlag)) {
            $rechipFullId = !empty($fullIsoRaw) ? 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw) : 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $activeChip2), 8, '0', STR_PAD_LEFT);
            if ($rechipFullId !== $shortId) {
                $rechipDate = null;
                if (!empty($rechipDateRaw)) { $ts = strtotime($rechipDateRaw); if ($ts) $rechipDate = date('Y-m-d', $ts); }
                if (!$dryRun) {
                    $pdo->prepare("INSERT INTO penguin_chips (pit_id, peng_num, chip_date, is_active, rechip_by) VALUES (?, ?, ?, TRUE, ?)")
                        ->execute([$rechipFullId, $number, $rechipDate, $rechipBy ?: null]);
                }
                $rechips++;
                $chipsCreated++;
            }
        }
    }

    echo json_encode([
        'success' => true,
        'dry_run' => $dryRun,
        'csv_rows' => count($rows),
        'previous' => ['penguins'=>$currentPenguins, 'chips'=>$currentChips],
        'result' => ['penguins'=>$created, 'chips'=>$chipsCreated, 'rechips'=>$rechips, 'skipped'=>$skipped],
        'chip_date_issues' => $chipDateIssues,
    ]);
    exit;
}

if ($action === 'import_sightings' || $action === 'trial_import_sightings') {
    set_time_limit(300);
    ini_set('memory_limit', '256M');
    $dryRun = ($action === 'trial_import_sightings');
    $monitorPrefix = 'sheet-import';
    $colonyId = 1; $observerId = 1;

    $csv = fetchGoogleSheet('325619240');
    if (!$csv) { echo json_encode(['error'=>'Google Sheets export failed']); exit; }

    $handle = fopen('php://temp', 'r+');
    fwrite($handle, $csv);
    rewind($handle);
    fgetcsv($handle); // skip header
    $rows = [];
    while (($row = fgetcsv($handle)) !== false) $rows[] = $row;
    fclose($handle);

    // Build chip lookup
    $chipLookup = []; $chipToPeng = [];
    foreach ($pdo->query("SELECT pit_id, peng_num FROM penguin_chips")->fetchAll() as $c) {
        $chipLookup[substr($c['pit_id'], -8)] = $c['pit_id'];
        $chipToPeng[substr($c['pit_id'], -8)] = $c['peng_num'];
    }

    // Parse and group by date+box
    $prevDate = null; $groups = [];
    foreach ($rows as $i => $row) {
        while (count($row) < 11) $row[] = '';
        $dateStr = trim($row[0]);
        if (!empty($dateStr)) {
            $ts = DateTime::createFromFormat('d/m/y', $dateStr);
            if (!$ts) { echo json_encode(['error'=>"Bad date '$dateStr' at row ".($i+2)]); exit; }
            $date = $ts->format('Y-m-d');
            $prevDate = $date;
        } else {
            $date = $prevDate;
        }
        if (!$date) continue;

        $box = trim($row[2]);
        if (empty($box)) continue;
        $boxUsed = strtoupper(trim($row[1]));
        $key = "$date|$box";
        if (!isset($groups[$key])) $groups[$key] = ['date'=>$date, 'box'=>$box, 'summary'=>null, 'birds'=>[], 'decomm'=>false, 'comments'=>[]];
        $g = &$groups[$key];
        if ($boxUsed === 'DECOMM') $g['decomm'] = true;

        $birdNum = trim($row[6]);
        $comment = trim($row[10]);
        if ($comment) $g['comments'][] = $comment;

        if (!empty($birdNum)) {
            $g['birds'][] = ['pit8'=>substr(preg_replace('/[^0-9]/', '', $birdNum), -8), 'sex'=>trim($row[7]), 'size_code'=>strtoupper(trim($row[8])), 'weight'=>trim($row[9]), 'comment'=>$comment];
        } elseif (trim($row[3]) !== '' || trim($row[4]) !== '' || trim($row[5]) !== '') {
            $g['summary'] = ['adults'=>(int)trim($row[3]), 'eggs'=>(int)trim($row[4]), 'chicks'=>(int)trim($row[5])];
        }
    }

    // Legacy wipe path removed — use wipe_sightings action instead
    if (false) {
        $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
        $pdo->exec("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename LIKE '{$monitorPrefix}%'");
        $pdo->exec("DELETE bd FROM penguin_biometric_data bd JOIN observations o ON bd.observation_id = o.observation_id WHERE o.monitor_filename LIKE '{$monitorPrefix}%'");
        $pdo->exec("DELETE FROM observations WHERE monitor_filename LIKE '{$monitorPrefix}%'");
        $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    }

    $stats = ['observations'=>0, 'empty_skipped'=>0, 'duplicates'=>0, 'scans'=>0, 'biometrics'=>0, 'unknown_count'=>0, 'unknown_pits'=>[], 'warnings'=>[]];

    foreach ($groups as $g) {
        $date = $g['date']; $box = $g['box'];
        if ($g['summary'] === null && count($g['birds']) === 0 && empty(implode('', $g['comments'])) && !$g['decomm']) { $stats['empty_skipped']++; continue; }

        $adults = $g['summary']['adults'] ?? count($g['birds']);
        $eggs = $g['summary']['eggs'] ?? 0;
        $chicks = $g['summary']['chicks'] ?? 0;
        $breedingStatus = $g['decomm'] ? 'DCM' : null;
        $notes = implode('; ', array_filter($g['comments']));
        $obsTime = $date . ' 02:00:00';

        $observationId = null;
        if (!$dryRun) {
            $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")->execute([$colonyId, $box]);
        }
        $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
        $stmt->execute([$colonyId, $box]);
        $locationId = $stmt->fetchColumn();

        if ($locationId) {
            // Check for existing observation
            $dup = $pdo->prepare("SELECT observation_id, adults, eggs, chicks, notes FROM observations WHERE location_id = ? AND observation_time_utc = ? AND monitor_filename LIKE ?");
            $dup->execute([$locationId, $obsTime, $monitorPrefix.'%']);
            $existing = $dup->fetch();
            if ($existing) {
                $observationId = $existing['observation_id'];
                // Check for content changes
                $changed = ((int)$existing['adults'] !== $adults || (int)$existing['eggs'] !== $eggs || (int)$existing['chicks'] !== $chicks || ($existing['notes'] ?? '') !== $notes);
                if ($changed) {
                    if (!$dryRun) {
                        $pdo->prepare("UPDATE observations SET adults=?, eggs=?, chicks=?, breeding_status=?, notes=? WHERE observation_id=?")
                            ->execute([$adults, $eggs, $chicks, $breedingStatus, $notes, $observationId]);
                    }
                    if (!isset($stats['updated'])) $stats['updated'] = 0;
                    $stats['updated']++;
                } else {
                    $stats['duplicates']++;
                }
                // Get existing scans for this observation to check for missing ones
                $existingScans = [];
                $scanStmt = $pdo->prepare("SELECT pit_id FROM penguin_scans WHERE observation_id = ?");
                $scanStmt->execute([$observationId]);
                foreach ($scanStmt->fetchAll() as $es) $existingScans[$es['pit_id']] = true;
            } else {
                $existingScans = [];
            }
        } else {
            $existingScans = [];
        }

        if (!$existing) {
            if (!$dryRun) {
                if (!$locationId) continue;
                $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)")
                    ->execute([$locationId, $observerId, $obsTime, $adults, $eggs, $chicks, $breedingStatus, null, $notes, $monitorPrefix.'-'.$date]);
                $observationId = $pdo->lastInsertId();
            }
            $stats['observations']++;
        }

        // 3+ penguins warning (only for new observations)
        if (!$existing && count($g['birds']) >= 3) {
            $birdNums = array_map(function($b) use ($chipToPeng) { return 'peng#'.($chipToPeng[$b['pit8']] ?? $b['pit8']); }, $g['birds']);
            $stats['warnings'][] = "$date box $box: ".count($g['birds'])." penguins (".implode(', ', $birdNums).")";
        }

        foreach ($g['birds'] as $bird) {
            $pit8 = $bird['pit8'];
            if (!isset($chipLookup[$pit8])) {
                $stats['unknown_count']++;
                if (!isset($stats['unknown_pits'][$pit8])) {
                    // Find close match
                    $close = null;
                    foreach ($chipLookup as $known => $fullPit) {
                        $knownStr = (string)$known;
                        if (strlen($knownStr) === strlen($pit8)) {
                            $diff = 0;
                            for ($d = 0; $d < strlen($pit8); $d++) { if ($pit8[$d] !== $knownStr[$d]) $diff++; }
                            if ($diff === 1) { $close = $knownStr . ' (peng#' . ($chipToPeng[$knownStr] ?? $chipToPeng[$known] ?? '?') . ')'; break; }
                        }
                    }
                    $stats['unknown_pits'][$pit8] = ['count'=>0, 'close'=>$close, 'first_date'=>$date, 'first_box'=>$box];
                }
                $stats['unknown_pits'][$pit8]['count']++;
                continue;
            }
            $pitId = $chipLookup[$pit8]; $pengNum = $chipToPeng[$pit8];

            // Skip if scan already exists for this observation
            if (isset($existingScans[$pitId])) continue;

            if (!$dryRun && $observationId) {
                $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc) VALUES (?,?,?)")->execute([$observationId, $pitId, $obsTime]);
            }
            $stats['scans']++;

            $sex = strtoupper($bird['sex']);
            $sexNorm = ($sex === 'M' || $sex === 'UM') ? 'M' : (($sex === 'F' || $sex === 'UF') ? 'F' : null);
            $weight = $bird['weight'] !== '' ? (float)$bird['weight'] : null;
            $flipper = null;
            if ($bird['comment'] && preg_match('/flipper[:\s]*(\d+)/i', $bird['comment'], $m)) $flipper = (float)$m[1];

            if (($weight || $sexNorm || $bird['comment'] || $flipper) && $pengNum) {
                if (!$dryRun && $observationId) {
                    $pdo->prepare("INSERT INTO penguin_biometric_data (peng_num, observation_id, observation_date, observed_sex, weight, right_flipper_length, notes) VALUES (?,?,?,?,?,?,?)")
                        ->execute([$pengNum, $observationId, $date, $sexNorm, $weight, $flipper, $bird['comment'] ?: null]);
                }
                $stats['biometrics']++;
            }

            // Update chick_size_code on penguin if available and not already set
            $sizeCode = $bird['size_code'] ?? '';
            if ($sizeCode && $pengNum && !$dryRun) {
                $pdo->prepare("UPDATE penguins SET chick_size_code = ? WHERE peng_num = ? AND (chick_size_code IS NULL OR chick_size_code = '')")
                    ->execute([$sizeCode, $pengNum]);
            }
        }
    }

    echo json_encode([
        'success' => true,
        'dry_run' => $dryRun,
        'csv_rows' => count($rows),
        'groups' => count($groups),
        'stats' => $stats,
    ]);
    exit;
}

echo json_encode(['error'=>'Unknown action']);
