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

if ($action === 'sync_monitors') {
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
            $monitorResults[] = ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'status'=>'deleted', 'new_obs'=>0, 'scans'=>0, 'skipped'=>0];
            continue;
        }

        $monNewObs = 0; $monScans = 0; $monSkipped = 0;

        foreach ($monitor['BoxData'] ?? [] as $boxName => $boxData) {
            $pdo->prepare("INSERT IGNORE INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")
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

            $stmt = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)");
            $stmt->execute([$locationId, $observerId, $obsTimeParsed,
                $boxData['Adults'] ?? 0, $boxData['Eggs'] ?? 0, $boxData['Chicks'] ?? 0,
                $boxData['BreedingChance'] ?? null, $boxData['GateStatus'] ?? null,
                $boxData['Notes'] ?? '', $filename]);
            $observationId = $pdo->lastInsertId();
            $monNewObs++;

            foreach ($boxData['ScannedIds'] ?? [] as $scan) {
                $birdId = $scan['BirdId'] ?? '';
                if (empty($birdId)) continue;
                $cleanId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $birdId));
                $short8 = strlen($cleanId) >= 8 ? substr($cleanId, -8) : $cleanId;
                if (substr($short8, 0, 4) === '9130' || strpos($birdId, 'LA9000250') !== false) continue;

                if (isset($chipLookup[$short8])) {
                    $scanTime = $scan['Timestamp'] ?? $obsTimeParsed;
                    $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc) VALUES (?,?,?)")
                        ->execute([$observationId, $chipLookup[$short8], date('Y-m-d H:i:s', strtotime($scanTime))]);
                    $monScans++;
                }
            }
        }
        $status = $monNewObs > 0 ? 'imported' : ($monSkipped > 0 ? 'already_imported' : 'empty');
        $monitorResults[] = ['filename'=>$filename, 'date'=>$lastSaved, 'boxes'=>$boxCount, 'status'=>$status, 'new_obs'=>$monNewObs, 'scans'=>$monScans, 'skipped'=>$monSkipped];
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

echo json_encode(['error'=>'Unknown action']);
