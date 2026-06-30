<?php
/**
 * NestCheck app sync endpoint.
 *
 * GET  /penguin-api/sync.php              - Download latest observation per box with scans
 * POST /penguin-api/sync.php?action=upload - Upload dirty observations from app
 *
 * All requests require Bearer token (session auth) or X-API-Key (observer API key).
 */
require_once 'config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();
$observer = authenticate($pdo);
if (!$observer) { http_response_code(401); echo json_encode(['error' => 'Not authenticated']); exit; }

$action = $_GET['action'] ?? '';
$colonyId = (int)($_GET['colony_id'] ?? 1);

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === '') {
    requireColonyAccess($pdo, $observer, $colonyId);        // view
    handleDownload($pdo, $colonyId, $observer);
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && ($action === 'upload' || $action === 'confirm')) {
    requireColonyAccess($pdo, $observer, $colonyId, true);  // edit
    handleUpload($pdo, $colonyId, $observer);
} else {
    echo json_encode(['error' => 'Unknown action']);
}

function authenticate($pdo) {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';

    // Try Bearer token (session auth)
    if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) {
        $stmt = $pdo->prepare("SELECT o.* FROM sessions s JOIN observers o ON s.observer_id = o.observer_id WHERE s.token = ? AND s.expires_at > NOW()");
        $stmt->execute([$m[1]]);
        $result = $stmt->fetch();
        if ($result) return $result;
    }

    return null;
}

/**
 * GET: Download latest observation per box with scans.
 */
function handleDownload($pdo, $colonyId, $observer) {
    // Latest observation per box, plus second-most-recent for boxes where latest is today
    $nzToday = (new DateTime('now', new DateTimeZone('Pacific/Auckland')))->format('Y-m-d');

    // First: get latest per box
    $stmt = $pdo->prepare("
        SELECT o.observation_id, o.location_id, ol.location_name AS box_name,
            o.observation_time_utc, o.monitor_filename, o.observer_id,
            ob.observer_name,
            o.adults, o.eggs, o.chicks, o.no_scan, o.breeding_status, o.gate_status, o.notes
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        LEFT JOIN observers ob ON o.observer_id = ob.observer_id
        WHERE ol.colony_id = ? AND o.is_deleted = FALSE
        AND o.observation_id = (
            SELECT o2.observation_id FROM observations o2
            WHERE o2.location_id = o.location_id AND o2.is_deleted = FALSE
            ORDER BY o2.observation_time_utc DESC LIMIT 1
        )
        ORDER BY ol.location_name + 0, ol.location_name
    ");
    $stmt->execute([$colonyId]);
    $latestObs = $stmt->fetchAll();

    // Find boxes where latest is from today — fetch their second-most-recent
    $todayBoxLocationIds = [];
    foreach ($latestObs as $obs) {
        $obsNzDate = (new DateTime($obs['observation_time_utc'], new DateTimeZone('UTC')))->setTimezone(new DateTimeZone('Pacific/Auckland'))->format('Y-m-d');
        if ($obsNzDate === $nzToday) $todayBoxLocationIds[] = $obs['location_id'];
    }

    $previousObs = [];
    if (!empty($todayBoxLocationIds)) {
        $ph = implode(',', array_fill(0, count($todayBoxLocationIds), '?'));
        $prevStmt = $pdo->prepare("
            SELECT o.observation_id, o.location_id, ol.location_name AS box_name,
                o.observation_time_utc, o.monitor_filename, o.observer_id,
                ob.observer_name,
                o.adults, o.eggs, o.chicks, o.no_scan, o.breeding_status, o.gate_status, o.notes
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            LEFT JOIN observers ob ON o.observer_id = ob.observer_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE
            AND o.location_id IN ($ph)
            AND o.observation_id = (
                SELECT o3.observation_id FROM observations o3
                WHERE o3.location_id = o.location_id AND o3.is_deleted = FALSE
                ORDER BY o3.observation_time_utc DESC LIMIT 1 OFFSET 1
            )
        ");
        $prevStmt->execute(array_merge([$colonyId], $todayBoxLocationIds));
        $previousObs = $prevStmt->fetchAll();
    }

    $observations = array_merge($latestObs, $previousObs);

    // Batch fetch scans for all these observations
    $obsIds = array_column($observations, 'observation_id');
    $scansByObs = [];
    if (!empty($obsIds)) {
        $ph = implode(',', array_fill(0, count($obsIds), '?'));
        $scanStmt = $pdo->prepare("SELECT ps.observation_id, ps.pit_id, ps.scan_time_utc,
            pc.peng_num, p.sex, p.chick_size_code, p.chipped_as_adult
            FROM penguin_scans ps
            LEFT JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 1
            LEFT JOIN penguins p ON pc.peng_num = p.peng_num
            WHERE ps.observation_id IN ($ph) AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)");
        $scanStmt->execute(array_values($obsIds));
        foreach ($scanStmt->fetchAll() as $scan) {
            $scansByObs[$scan['observation_id']][] = [
                'pit_id' => $scan['pit_id'],
                'scan_time_utc' => $scan['scan_time_utc'],
                'peng_num' => $scan['peng_num'],
                'sex' => $scan['sex'],
                'chick_size_code' => $scan['chick_size_code'],
                'chipped_as_adult' => $scan['chipped_as_adult'],
            ];
        }
    }

    // Build response: latest per box + previous for today's boxes
    $boxes = [];
    $previous = [];
    $latestIds = [];
    foreach ($latestObs as $obs) {
        $boxName = $obs['box_name'];
        $boxes[$boxName] = [
            'observation_id' => (int)$obs['observation_id'],
            'location_id' => (int)$obs['location_id'],
            'observation_time_utc' => $obs['observation_time_utc'],
            'monitor_filename' => $obs['monitor_filename'],
            'observer_name' => $obs['observer_name'],
            'adults' => (int)$obs['adults'],
            'eggs' => (int)$obs['eggs'],
            'chicks' => (int)$obs['chicks'],
            'no_scan' => (int)($obs['no_scan'] ?? 0),
            'breeding_status' => $obs['breeding_status'],
            'gate_status' => $obs['gate_status'],
            'notes' => $obs['notes'],
            'scans' => $scansByObs[$obs['observation_id']] ?? [],
        ];
    }
    foreach ($previousObs as $obs) {
        $boxName = $obs['box_name'];
        $previous[$boxName] = [
            'observation_id' => (int)$obs['observation_id'],
            'location_id' => (int)$obs['location_id'],
            'observation_time_utc' => $obs['observation_time_utc'],
            'monitor_filename' => $obs['monitor_filename'],
            'observer_name' => $obs['observer_name'],
            'adults' => (int)$obs['adults'],
            'eggs' => (int)$obs['eggs'],
            'chicks' => (int)$obs['chicks'],
            'no_scan' => (int)($obs['no_scan'] ?? 0),
            'breeding_status' => $obs['breeding_status'],
            'gate_status' => $obs['gate_status'],
            'notes' => $obs['notes'],
            'scans' => $scansByObs[$obs['observation_id']] ?? [],
        ];
    }

    // Locations
    $locStmt = $pdo->prepare("SELECT location_id, location_name, persistent_notes FROM observation_locations WHERE colony_id = ?");
    $locStmt->execute([$colonyId]);

    echo json_encode([
        'snapshot_time' => date('c'),
        'observer' => ['observer_id' => (int)$observer['observer_id'], 'name' => $observer['observer_name']],
        'boxes' => (object)$boxes,
        'previous' => (object)$previous,
        'locations' => $locStmt->fetchAll(),
    ]);
}

/**
 * POST ?action=upload: Upload dirty observations from app.
 * If a box already has today's observation on the server, returns it as a conflict
 * instead of overwriting. Use ?action=confirm to force-replace conflicts.
 */
function handleUpload($pdo, $colonyId, $observer) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['observations'])) {
        http_response_code(400);
        echo json_encode(['error' => 'JSON body with observations array required']);
        return;
    }

    $forceReplace = ($_GET['action'] === 'confirm');
    $dailyLabel = $input['daily_label'] ?? '';
    $observerId = (int)$observer['observer_id'];
    $created = [];
    $conflicts = [];
    $errors = [];

    $nzToday = (new DateTime('now', new DateTimeZone('Pacific/Auckland')))->format('Y-m-d');

    // Build chip lookup for validating pit_ids
    $chipLookup = [];
    foreach ($pdo->query("SELECT pit_id FROM penguin_chips")->fetchAll() as $c) {
        $chipLookup[strtoupper($c['pit_id'])] = $c['pit_id'];
        $chipLookup[strtoupper(substr($c['pit_id'], -8))] = $c['pit_id'];
    }

    // Batch-fetch scans for conflict display
    $fetchScansForObs = function($obsId) use ($pdo, $chipLookup) {
        $s = $pdo->prepare("SELECT ps.pit_id, ps.scan_time_utc, pc.peng_num, p.sex, p.chick_size_code
            FROM penguin_scans ps LEFT JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 1
            LEFT JOIN penguins p ON pc.peng_num = p.peng_num WHERE ps.observation_id = ? AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)");
        $s->execute([$obsId]);
        return $s->fetchAll();
    };

    $pdo->beginTransaction();
    try {
        foreach ($input['observations'] as $obs) {
            $boxName = $obs['box_name'] ?? null;
            if ($boxName === null || $boxName === '') { $errors[] = ['error' => 'Missing box_name', 'obs' => $obs]; continue; }

            // Look up location_id
            $locStmt = $pdo->prepare("SELECT location_id FROM observation_locations WHERE colony_id = ? AND location_name = ?");
            $locStmt->execute([$colonyId, $boxName]);
            $locationId = $locStmt->fetchColumn();
            if (!$locationId) {
                $pdo->prepare("INSERT INTO observation_locations (colony_id, location_name, location_type) VALUES (?, ?, 'box')")
                    ->execute([$colonyId, $boxName]);
                $locationId = $pdo->lastInsertId();
            }

            $obsTime = $obs['observation_time_utc'] ?? date('Y-m-d H:i:s');

            // Check if this box already has today's observation on the server
            if (!$forceReplace) {
                $existingStmt = $pdo->prepare("SELECT o.observation_id, o.observation_time_utc, o.adults, o.eggs, o.chicks, o.no_scan,
                    o.breeding_status, o.gate_status, o.notes, o.monitor_filename, ob.observer_name
                    FROM observations o LEFT JOIN observers ob ON o.observer_id = ob.observer_id
                    WHERE o.location_id = ? AND o.is_deleted = FALSE
                    AND DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) = ?
                    ORDER BY o.observation_time_utc DESC LIMIT 1");
                $existingStmt->execute([$locationId, $nzToday]);
                $existing = $existingStmt->fetch();

                if ($existing) {
                    // Optimistic concurrency: if client confirmed against this exact observation, auto-replace
                    $expectedObsId = $obs['expected_observation_id'] ?? null;
                    if ($expectedObsId !== null && (int)$expectedObsId === (int)$existing['observation_id']) {
                        $forceReplace = true;
                        // Fall through to the force-replace logic below
                    } else {
                        // Conflict: server data differs from what client expected
                        $conflicts[] = [
                            'box_name' => $boxName,
                            'server' => [
                                'observation_id' => (int)$existing['observation_id'],
                                'observation_time_utc' => $existing['observation_time_utc'],
                                'observer_name' => $existing['observer_name'],
                                'adults' => (int)$existing['adults'],
                                'eggs' => (int)$existing['eggs'],
                                'chicks' => (int)$existing['chicks'],
                                'no_scan' => (int)($existing['no_scan'] ?? 0),
                                'breeding_status' => $existing['breeding_status'],
                                'gate_status' => $existing['gate_status'],
                                'notes' => $existing['notes'],
                                'monitor_filename' => $existing['monitor_filename'],
                                'scans' => $fetchScansForObs($existing['observation_id']),
                            ],
                            'incoming' => $obs,
                        ];
                        continue; // Skip — don't write
                    }
                }
            }

            // Count no-scan placeholders
            $noScanCount = 0;
            foreach ($obs['scans'] ?? [] as $sc) {
                if (str_starts_with(strtoupper($sc['pit_id'] ?? ''), 'NOSCAN')) $noScanCount++;
            }

            // Create or force-replace (update in-place to preserve audit trail)
            if ($forceReplace) {
                $existingStmt = $pdo->prepare("SELECT observation_id FROM observations
                    WHERE location_id = ? AND is_deleted = FALSE
                    AND DATE(CONVERT_TZ(observation_time_utc, '+00:00', '+12:00')) = ?
                    ORDER BY observation_time_utc DESC LIMIT 1");
                $existingStmt->execute([$locationId, $nzToday]);
                $existingId = $existingStmt->fetchColumn();

                if ($existingId) {
                    // Update existing observation in-place
                    $pdo->prepare("UPDATE observations SET observer_id=?, observation_time_utc=?, adults=?, eggs=?, chicks=?, breeding_status=?, gate_status=?, notes=?, monitor_filename=?, no_scan=? WHERE observation_id=?")
                        ->execute([
                            $observerId, $obsTime,
                            (int)($obs['adults'] ?? 0), (int)($obs['eggs'] ?? 0), (int)($obs['chicks'] ?? 0),
                            $obs['breeding_status'] ?? null, $obs['gate_status'] ?? null, $obs['notes'] ?? '',
                            $dailyLabel ?: null, $noScanCount, $existingId,
                        ]);
                    $observationId = $existingId;
                    // Soft-delete old scans — will be recreated below
                    $pdo->prepare("UPDATE penguin_scans SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ? AND (is_deleted = FALSE OR is_deleted IS NULL)")
                        ->execute([$observerId, $observationId]);
                } else {
                    // No existing — create new
                    $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename, no_scan) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                        ->execute([$locationId, $observerId, $obsTime,
                            (int)($obs['adults'] ?? 0), (int)($obs['eggs'] ?? 0), (int)($obs['chicks'] ?? 0),
                            $obs['breeding_status'] ?? null, $obs['gate_status'] ?? null, $obs['notes'] ?? '',
                            $dailyLabel ?: null, $noScanCount]);
                    $observationId = $pdo->lastInsertId();
                }
            } else {
                $stmt = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, breeding_status, gate_status, notes, monitor_filename, no_scan) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
                $stmt->execute([
                    $locationId, $observerId, $obsTime,
                    (int)($obs['adults'] ?? 0), (int)($obs['eggs'] ?? 0), (int)($obs['chicks'] ?? 0),
                    $obs['breeding_status'] ?? null, $obs['gate_status'] ?? null, $obs['notes'] ?? '',
                    $dailyLabel ?: null, $noScanCount,
                ]);
                $observationId = $pdo->lastInsertId();
            }

            // Create penguin scans
            $scansCreated = 0;
            foreach ($obs['scans'] ?? [] as $scan) {
                $pitId = $scan['pit_id'] ?? '';
                if (empty($pitId)) continue;

                $scanTime = $scan['scan_time_utc'] ?? $obsTime;
                $lat = isset($scan['latitude']) && $scan['latitude'] != 0 ? $scan['latitude'] : null;
                $lon = isset($scan['longitude']) && $scan['longitude'] != 0 ? $scan['longitude'] : null;
                $acc = isset($scan['accuracy']) && $scan['accuracy'] > 0 ? $scan['accuracy'] : null;

                // No-scan placeholder — skip DB, these are app-only placeholders
                if (str_starts_with(strtoupper($pitId), 'NOSCAN')) continue;

                // Resolve short IDs to full pit_id
                $cleanId = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $pitId));
                $fullPitId = $chipLookup[$cleanId] ?? $chipLookup[substr($cleanId, -8)] ?? null;
                if (!$fullPitId) { $errors[] = ['error' => "Unknown pit_id: $pitId", 'box' => $boxName]; continue; }

                // Skip duplicate pit_id for same observation
                $dupCheck = $pdo->prepare("SELECT scan_id FROM penguin_scans WHERE observation_id = ? AND pit_id = ? AND (is_deleted = FALSE OR is_deleted IS NULL)");
                $dupCheck->execute([$observationId, $fullPitId]);
                if ($dupCheck->fetch()) continue;

                $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc, latitude, longitude, accuracy) VALUES (?,?,?,?,?,?)")
                    ->execute([$observationId, $fullPitId, $scanTime, $lat, $lon, $acc]);
                $scansCreated++;
            }

            // Audit log — record actual observation data
            $action = $forceReplace ? 'UPDATE' : 'INSERT';
            $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observations', ?, ?, ?, ?)")
                ->execute([$observationId, $action, $observerId, json_encode([
                    'source' => 'nestcheck_sync',
                    'box' => $boxName,
                    'adults' => (int)($obs['adults'] ?? 0),
                    'eggs' => (int)($obs['eggs'] ?? 0),
                    'chicks' => (int)($obs['chicks'] ?? 0),
                    'breeding_status' => $obs['breeding_status'] ?? null,
                    'gate_status' => $obs['gate_status'] ?? null,
                    'notes' => $obs['notes'] ?? '',
                    'daily_label' => $dailyLabel,
                    'scans' => $scansCreated,
                ])]);

            $created[] = ['box_name' => $boxName, 'observation_id' => (int)$observationId, 'scans' => $scansCreated];
        }

        $pdo->commit();
        $response = ['success' => true, 'created' => $created, 'errors' => $errors];
        if (!empty($conflicts)) $response['conflicts'] = $conflicts;
        @file_put_contents(__DIR__ . '/sync_debug.log', date('Y-m-d H:i:s') . ' ' . json_encode($response) . "\n", FILE_APPEND);
        echo json_encode($response);
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
}
