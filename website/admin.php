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
    $params[] = $input['observer_id'];
    $pdo->prepare("UPDATE observers SET " . implode(', ', $sets) . " WHERE observer_id = ?")->execute($params);
    echo json_encode(['success'=>true]);
    exit;
}

if ($action === 'wipe_monitors') {
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    $del1 = $pdo->exec("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename NOT LIKE 'sheet-import%'");
    $del2 = $pdo->exec("DELETE FROM observations WHERE monitor_filename NOT LIKE 'sheet-import%'");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    echo json_encode(['success'=>true, 'deleted_scans'=>$del1, 'deleted_observations'=>$del2]);
    exit;
}

if ($action === 'wipe_sightings') {
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    $del1 = $pdo->exec("DELETE ps FROM penguin_scans ps JOIN observations o ON ps.observation_id = o.observation_id WHERE o.monitor_filename LIKE 'sheet-import%'");
    $del2 = $pdo->exec("DELETE bd FROM penguin_biometric_data bd JOIN observations o ON bd.observation_id = o.observation_id WHERE o.monitor_filename LIKE 'sheet-import%'");
    $del3 = $pdo->exec("DELETE FROM observations WHERE monitor_filename LIKE 'sheet-import%'");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    echo json_encode(['success'=>true, 'deleted_scans'=>$del1, 'deleted_biometrics'=>$del2, 'deleted_observations'=>$del3]);
    exit;
}

if ($action === 'wipe_penguins') {
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    $pdo->exec("DELETE FROM penguin_scans");
    $pdo->exec("DELETE FROM penguin_biometric_data");
    $pdo->exec("DELETE FROM penguin_chips");
    $pdo->exec("DELETE FROM penguins");
    $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
    echo json_encode(['success'=>true, 'message'=>'All penguins, chips, scans and biometrics deleted']);
    exit;
}

if ($action === 'sync_monitors' || $action === 'trial_sync') {
    $dryRun = ($action === 'trial_sync');
    // Pull from old TCP server using same protocol as C# app
    $host = '210.54.37.120';
    $port = 8080;
    $passphrase = 'bbnmdsfhsecureafdgsadsadff';

    $sock = @fsockopen($host, $port, $errno, $errstr, 5);
    if (!$sock) { echo json_encode(['error'=>"Cannot connect: $errstr"]); exit; }
    stream_set_timeout($sock, 10);

    // RSA key exchange
    $rsa = openssl_pkey_new(['private_key_bits'=>1024, 'private_key_type'=>OPENSSL_KEYTYPE_RSA]);
    $details = openssl_pkey_get_details($rsa);
    $modulus = $details['rsa']['n'];
    $exponent = $details['rsa']['e'];

    fwrite($sock, base64_encode($modulus) . "\r\n");
    fwrite($sock, base64_encode($exponent) . "\r\n");

    $encKey = base64_decode(trim(fgets($sock)));
    $encIv = base64_decode(trim(fgets($sock)));

    openssl_private_decrypt($encKey, $aesKey, $rsa);
    openssl_private_decrypt($encIv, $aesIv, $rsa);

    // Encrypt passphrase (UTF-16LE like C#)
    $passBytes = mb_convert_encoding($passphrase, 'UTF-16LE', 'UTF-8');
    $encPass = openssl_encrypt($passBytes, 'aes-256-cbc', $aesKey, OPENSSL_RAW_DATA, $aesIv);
    fwrite($sock, base64_encode($encPass) . "\r\n");

    // Send request
    $question = 'PenguinRequest-Saved:';
    $qBytes = mb_convert_encoding($question, 'UTF-16LE', 'UTF-8');
    $encQ = openssl_encrypt($qBytes, 'aes-256-cbc', $aesKey, OPENSSL_RAW_DATA, $aesIv);
    fwrite($sock, base64_encode($encQ) . "\r\n");

    // Read response
    $encResp = base64_decode(trim(fgets($sock, 1048576 * 4)));
    fclose($sock);

    $decResp = openssl_decrypt($encResp, 'aes-256-cbc', $aesKey, OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, $aesIv);
    // Remove PKCS padding
    $padLen = ord($decResp[strlen($decResp) - 1]);
    $decResp = substr($decResp, 0, -$padLen);
    $reply = mb_convert_encoding($decResp, 'UTF-8', 'UTF-16LE');

    // Parse monitors (separated by ~~~~)
    $parts = explode('~~~~', $reply);
    $monitors = [];
    foreach ($parts as $part) {
        $part = trim($part);
        if (empty($part)) continue;
        $m = json_decode($part, true);
        if ($m) $monitors[] = $m;
    }

    // Build chip lookup
    $chipLookup = [];
    foreach ($pdo->query("SELECT pit_id FROM penguin_chips")->fetchAll() as $c) {
        $short = strtoupper(substr($c['pit_id'], -8));
        $chipLookup[$short] = $c['pit_id'];
    }

    // Import new monitors
    $colonyId = 1; $observerId = 1;
    $monitorResults = [];

    // Process newest first
    usort($monitors, function($a, $b) {
        return strcmp($b['LastSaved'] ?? '', $a['LastSaved'] ?? '');
    });

    foreach ($monitors as $monitor) {
        $filename = $monitor['filename'] ?? 'unknown';
        $lastSaved = $monitor['LastSaved'] ?? null;
        $boxCount = count($monitor['BoxData'] ?? []);

        if ($monitor['IsDeleted'] ?? false) {
            $monitorResults[] = ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'status'=>'deleted', 'new_obs'=>0, 'scans'=>0, 'skipped'=>0, 'adults'=>0, 'eggs'=>0, 'chicks'=>0];
            continue;
        }

        $monNewObs = 0; $monScans = 0; $monSkipped = 0;
        $monAdults = 0; $monEggs = 0; $monChicks = 0;

        foreach ($monitor['BoxData'] ?? [] as $boxName => $boxData) {
            $monAdults += (int)($boxData['Adults'] ?? 0);
            $monEggs += (int)($boxData['Eggs'] ?? 0);
            $monChicks += (int)($boxData['Chicks'] ?? 0);
            if (!$dryRun) $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")
                ->execute([$colonyId, $boxName]);
            $stmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
            $stmt->execute([$colonyId, $boxName]);
            $locationId = $stmt->fetchColumn();
            if (!$locationId) continue;

            $obsTime = $boxData['whenDataCollectedUtc'] ?? $monitor['LastSaved'] ?? date('Y-m-d H:i:s');
            $obsTimeParsed = date('Y-m-d H:i:s', strtotime($obsTime));

            // Skip duplicates
            $stmt = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND observer_id = ?");
            $stmt->execute([$locationId, $obsTimeParsed, $observerId]);
            if ($stmt->fetchColumn()) { $monSkipped++; continue; }

            if (!$dryRun) {
                $stmt = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)");
                $stmt->execute([$locationId, $observerId, $obsTimeParsed,
                    $boxData['Adults'] ?? 0, $boxData['Eggs'] ?? 0, $boxData['Chicks'] ?? 0,
                    $boxData['BreedingChance'] ?? null, $boxData['GateStatus'] ?? null,
                    $boxData['Notes'] ?? '', $filename]);
                $observationId = $pdo->lastInsertId();
            }
            $monNewObs++;

            foreach ($boxData['ScannedIds'] ?? [] as $scan) {
                $birdId = $scan['BirdId'] ?? '';
                if (empty($birdId)) continue;
                $cleanId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $birdId));
                $short8 = strlen($cleanId) >= 8 ? substr($cleanId, -8) : $cleanId;
                if (substr($short8, 0, 4) === '9130' || strpos($birdId, 'LA9000250') !== false) continue;

                if (isset($chipLookup[$short8])) {
                    if (!$dryRun && isset($observationId)) {
                        $scanTime = $scan['Timestamp'] ?? $obsTimeParsed;
                        $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc) VALUES (?,?,?)")
                            ->execute([$observationId, $chipLookup[$short8], date('Y-m-d H:i:s', strtotime($scanTime))]);
                    }
                    $monScans++;
                }
            }
        }
        $status = $monNewObs > 0 ? ($dryRun ? 'would_import' : 'imported') : ($monSkipped > 0 ? 'already_imported' : 'empty');
        $monitorResults[] = ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'boxes_imported'=>$monNewObs, 'boxes_skipped'=>$monSkipped, 'status'=>$status, 'scans'=>$monScans, 'adults'=>$monAdults, 'eggs'=>$monEggs, 'chicks'=>$monChicks];
    }

    $totals = ['new_obs'=>0, 'scans'=>0, 'skipped'=>0, 'deleted'=>0, 'already_imported'=>0, 'imported'=>0];
    foreach ($monitorResults as $mr) {
        $totals['new_obs'] += $mr['new_obs'];
        $totals['scans'] += $mr['scans'];
        $totals['skipped'] += $mr['skipped'];
        if ($mr['status'] === 'deleted') $totals['deleted']++;
        elseif ($mr['status'] === 'already_imported') $totals['already_imported']++;
        elseif ($mr['status'] === 'imported') $totals['imported']++;
    }

    echo json_encode([
        'success' => true,
        'totals' => $totals,
        'monitors' => $monitorResults,
    ]);
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
        if (empty($dateStr)) continue;
        $ts = DateTime::createFromFormat('d/m/y', $dateStr);
        if (!$ts) { echo json_encode(['error'=>"Bad date '$dateStr' at row ".($i+2)]); exit; }
        $date = $ts->format('Y-m-d');
        if ($prevDate && $date < $prevDate) { echo json_encode(['error'=>"Date decrease at row ".($i+2).": $date < $prevDate"]); exit; }
        $prevDate = $date;

        $boxUsed = strtoupper(trim($row[1]));
        $box = trim($row[2]);
        if (empty($box)) continue;
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

    $stats = ['observations'=>0, 'skipped'=>0, 'scans'=>0, 'biometrics'=>0, 'unknown_count'=>0, 'unknown_pits'=>[], 'warnings'=>[]];

    foreach ($groups as $g) {
        $date = $g['date']; $box = $g['box'];
        if ($g['summary'] === null && count($g['birds']) === 0 && empty(implode('', $g['comments'])) && !$g['decomm']) { $stats['skipped']++; continue; }

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
            // Skip duplicates
            $dup = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND monitor_filename LIKE ?");
            $dup->execute([$locationId, $obsTime, $monitorPrefix.'%']);
            if ($dup->fetchColumn()) { $stats['skipped']++; continue; }
        }

        if (!$dryRun) {
            if (!$locationId) {
                // Shouldn't happen since we inserted above, but just in case
                continue;
            }
            $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)")
                ->execute([$locationId, $observerId, $obsTime, $adults, $eggs, $chicks, $breedingStatus, null, $notes, $monitorPrefix.'-'.$date]);
            $observationId = $pdo->lastInsertId();
        }
        $stats['observations']++;

        // 3+ penguins warning
        if (count($g['birds']) >= 3) {
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
                        if (strlen($known) === strlen($pit8)) {
                            $diff = 0;
                            for ($d = 0; $d < strlen($pit8); $d++) { if ($pit8[$d] !== $known[$d]) $diff++; }
                            if ($diff === 1) { $close = $known . ' (peng#' . ($chipToPeng[$known] ?? '?') . ')'; break; }
                        }
                    }
                    $stats['unknown_pits'][$pit8] = ['count'=>0, 'close'=>$close, 'first_date'=>$date, 'first_box'=>$box];
                }
                $stats['unknown_pits'][$pit8]['count']++;
                continue;
            }
            $pitId = $chipLookup[$pit8]; $pengNum = $chipToPeng[$pit8];

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
