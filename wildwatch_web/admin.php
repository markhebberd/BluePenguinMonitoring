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

// Read-only SQL console. Available to all admins (role gate enforced above).
if ($action === 'sql') {
    $input = json_decode(file_get_contents('php://input'), true) ?? [];
    $sql = trim($input['sql'] ?? '');
    if ($sql === '') { echo json_encode(['error' => 'Empty query']); exit; }

    // Strip a single trailing semicolon; reject anything that looks like stacked statements.
    $sql = rtrim($sql, "; \t\n\r");
    if (strpos($sql, ';') !== false) { echo json_encode(['error' => 'Only a single statement is allowed']); exit; }

    // UX guardrail so mistakes fail fast. NOT the security boundary — that is the
    // SELECT-only grant on DB_RO_USER, which makes writes impossible regardless.
    if (!preg_match('/^(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC)\b/i', $sql)) {
        echo json_encode(['error' => 'Only SELECT / WITH / SHOW / EXPLAIN / DESCRIBE queries are allowed']); exit;
    }

    // Auto-cap row-returning queries; fetch one extra to detect truncation.
    $limit = 1000; $capped = false;
    if (preg_match('/^(SELECT|WITH)\b/i', $sql) && !preg_match('/\bLIMIT\s+\d/i', $sql)) {
        $sql .= " LIMIT " . ($limit + 1); $capped = true;
    }

    try {
        $ro = getReadOnlyDbConnection();
        $t0 = microtime(true);
        $stmt = $ro->query($sql);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $ms = (int) round((microtime(true) - $t0) * 1000);
        $truncated = false;
        if ($capped && count($rows) > $limit) { $rows = array_slice($rows, 0, $limit); $truncated = true; }
        $columns = $rows ? array_keys($rows[0]) : [];
        // Audit the query text (record_id 0 — not tied to a single row).
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('__sql_console', 0, 'SELECT', ?, ?)")
            ->execute([$observer['observer_id'], json_encode(['sql' => $sql], JSON_UNESCAPED_SLASHES)]);
        echo json_encode(['success' => true, 'columns' => $columns, 'rows' => $rows, 'rowCount' => count($rows), 'truncated' => $truncated, 'ms' => $ms]);
    } catch (PDOException $e) {
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

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

// ---- Data-integrity checks (whole-DB versions of the CSV-import validations) ----
define('WW_NZ', "DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))");

// A penguin scanned at two different boxes on the same day — can't be two places at once.
if ($action === 'bird_two_boxes') {
    echo json_encode($pdo->query("
        SELECT pc.peng_num, " . WW_NZ . " AS obs_date,
            COUNT(DISTINCT ol.location_name) AS box_count,
            GROUP_CONCAT(DISTINCT ol.location_name ORDER BY ol.location_name + 0) AS boxes
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
        WHERE o.is_deleted = FALSE AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
        GROUP BY pc.peng_num, " . WW_NZ . "
        HAVING box_count > 1
        ORDER BY obs_date DESC
        LIMIT 500")->fetchAll());
    exit;
}

// A scan dated before the bird's chip was fitted — impossible.
if ($action === 'scan_before_chip') {
    echo json_encode($pdo->query("
        SELECT pc.peng_num, pc.chip_date, ol.location_name AS box_name, " . WW_NZ . " AS obs_date
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
        WHERE o.is_deleted = FALSE AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
          AND pc.chip_date IS NOT NULL AND " . WW_NZ . " < pc.chip_date
        ORDER BY obs_date DESC
        LIMIT 500")->fetchAll());
    exit;
}

// Birds scanned AFTER their recorded death date — the death date or the scan is wrong.
if ($action === 'dead_scanned') {
    echo json_encode($pdo->query("
        SELECT p.peng_num, DATE(CONVERT_TZ(p.death_date, '+00:00', '+12:00')) AS death_date,
            MAX(" . WW_NZ . ") AS last_scan, COUNT(*) AS scan_count
        FROM penguins p
        JOIN penguin_chips pc ON pc.peng_num = p.peng_num
        JOIN penguin_scans ps ON ps.pit_id = pc.pit_id
        JOIN observations o ON ps.observation_id = o.observation_id
        WHERE p.death_date IS NOT NULL AND o.is_deleted = FALSE
          AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
          AND o.observation_time_utc > p.death_date
        GROUP BY p.peng_num, p.death_date
        ORDER BY last_scan DESC
        LIMIT 500")->fetchAll());
    exit;
}

// Improbable counts for a little-penguin box: adults > 2 or eggs + chicks > 2.
if ($action === 'improbable_counts') {
    echo json_encode($pdo->query("
        SELECT ol.location_name AS box_name, " . WW_NZ . " AS obs_date,
            o.adults, o.eggs, o.chicks, o.no_scan
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE o.is_deleted = FALSE AND (o.adults > 2 OR (o.eggs + o.chicks) > 2)
        ORDER BY obs_date DESC
        LIMIT 500")->fetchAll());
    exit;
}

// Observations dated in the future (NZ) — almost always a typo.
if ($action === 'future_observations') {
    echo json_encode($pdo->query("
        SELECT ol.location_name AS box_name, " . WW_NZ . " AS obs_date,
            COALESCE(ob.observer_name, '?') AS observer
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        LEFT JOIN observers ob ON o.observer_id = ob.observer_id
        WHERE o.is_deleted = FALSE
          AND " . WW_NZ . " > DATE(CONVERT_TZ(NOW(), '+00:00', '+12:00'))
        ORDER BY obs_date DESC
        LIMIT 500")->fetchAll());
    exit;
}

// Scans recorded via a retired (inactive) chip AFTER the bird got a newer active one.
if ($action === 'retired_tag_scans') {
    echo json_encode($pdo->query("
        SELECT pc.peng_num, ps.pit_id, ol.location_name AS box_name,
            " . WW_NZ . " AS obs_date, a.chip_date AS active_chip_date
        FROM penguin_scans ps
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 0
        JOIN penguin_chips a ON a.peng_num = pc.peng_num AND a.is_active = 1
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE o.is_deleted = FALSE AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
          AND a.chip_date IS NOT NULL AND " . WW_NZ . " > a.chip_date
        ORDER BY obs_date DESC
        LIMIT 500")->fetchAll());
    exit;
}

// Chicks chipped in a box, then chicks recorded there within the following month but with no
// scans on that observation — the chicks are chippable, so zero scans is a likely missed scan.
if ($action === 'chicks_no_scan') {
    echo json_encode($pdo->query("
        SELECT ol.location_name AS box_name, " . WW_NZ . " AS obs_date, o.chicks,
            (SELECT COUNT(DISTINCT pp.peng_num)
               FROM penguin_chips c JOIN penguins pp ON c.peng_num = pp.peng_num
               WHERE (c.location_id = o.location_id OR c.chip_box = ol.location_name)
                 AND pp.chipped_as_adult = 0
                 AND c.chip_date < " . WW_NZ . "
                 AND c.chip_date >= DATE_SUB(" . WW_NZ . ", INTERVAL 31 DAY)
            ) AS chicks_chipped
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE o.is_deleted = FALSE AND o.chicks > 0
          AND NOT EXISTS (SELECT 1 FROM penguin_scans ps
                          WHERE ps.observation_id = o.observation_id
                            AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL))
        HAVING chicks_chipped >= 2
        ORDER BY obs_date DESC
        LIMIT 500")->fetchAll());
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

if ($action === 'create_user') {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $name = trim($input['observer_name'] ?? '');
    $email = trim($input['email'] ?? '');
    $role = $input['role'] ?? 'viewer';
    $password = (string)($input['password'] ?? '');
    if ($name === '' || $password === '') { http_response_code(400); echo json_encode(['error'=>'Name and password are required']); exit; }
    if (strlen($password) < 6) { http_response_code(400); echo json_encode(['error'=>'Password must be at least 6 characters']); exit; }
    if (!in_array($role, ['viewer', 'editor', 'admin'], true)) { http_response_code(400); echo json_encode(['error'=>'Invalid role']); exit; }
    $dup = $pdo->prepare("SELECT observer_id FROM observers WHERE observer_name = ?");
    $dup->execute([$name]);
    if ($dup->fetch()) { http_response_code(409); echo json_encode(['error'=>"A user named \"$name\" already exists"]); exit; }
    $hash = password_hash($password, PASSWORD_BCRYPT);
    $pdo->prepare("INSERT INTO observers (observer_name, email, passphrase_hash, role) VALUES (?, ?, ?, ?)")
        ->execute([$name, $email !== '' ? $email : null, $hash, $role]);
    $id = (int)$pdo->lastInsertId();
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observers', ?, 'CREATE', ?, ?)")
        ->execute([$id, $observer['observer_id'], json_encode(['observer_name'=>$name, 'email'=>$email, 'role'=>$role])]);
    echo json_encode(['observer_id'=>$id, 'observer_name'=>$name, 'email'=>$email, 'role'=>$role, 'created_at'=>date('Y-m-d H:i:s')]);
    exit;
}

if ($action === 'reset_password') {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $id = (int)($input['observer_id'] ?? 0);
    $password = (string)($input['password'] ?? '');
    if (!$id) { http_response_code(400); echo json_encode(['error'=>'observer_id required']); exit; }
    if (strlen($password) < 6) { http_response_code(400); echo json_encode(['error'=>'Password must be at least 6 characters']); exit; }
    $chk = $pdo->prepare("SELECT observer_name FROM observers WHERE observer_id = ?");
    $chk->execute([$id]);
    $row = $chk->fetch();
    if (!$row) { http_response_code(404); echo json_encode(['error'=>'User not found']); exit; }
    $hash = password_hash($password, PASSWORD_BCRYPT);
    $pdo->prepare("UPDATE observers SET passphrase_hash = ? WHERE observer_id = ?")->execute([$hash, $id]);
    // Never log the password itself — just that it was reset.
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observers', ?, 'UPDATE', ?, ?)")
        ->execute([$id, $observer['observer_id'], json_encode(['passphrase_hash'=>'(reset)'])]);
    echo json_encode(['success'=>true, 'observer_name'=>$row['observer_name']]);
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
    // Locations excluded from Full Monitor detection (comma-separated). Only overwrite
    // when the key is present so callers that don't send it keep the existing value.
    $hasFmExcluded = is_array($input) && array_key_exists('fm_excluded_boxes', $input);
    $fmExcluded = trim($input['fm_excluded_boxes'] ?? '');
    if (!$name || !$regionId) { http_response_code(400); echo json_encode(['error' => 'colony_name and region_id required']); exit; }
    $id = $input['colony_id'] ?? null;
    if ($id) {
        if ($hasFmExcluded) {
            $pdo->prepare("UPDATE colonies SET colony_name = ?, region_id = ?, location_sets_string = ?, fm_excluded_boxes = ? WHERE colony_id = ?")
                ->execute([$name, $regionId, $locationSets, $fmExcluded, $id]);
        } else {
            $pdo->prepare("UPDATE colonies SET colony_name = ?, region_id = ?, location_sets_string = ? WHERE colony_id = ?")
                ->execute([$name, $regionId, $locationSets, $id]);
        }
    } else {
        $pdo->prepare("INSERT INTO colonies (colony_name, region_id, location_sets_string, fm_excluded_boxes) VALUES (?, ?, ?, ?)")
            ->execute([$name, $regionId, $locationSets, $hasFmExcluded ? $fmExcluded : '0,AA,AB,AC']);
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

// ============ Monitor CSV import ============
// Two-phase: analyze (no writes) then commit. Both call ww_parseImportCsv so the
// analysis page reflects exactly what the import will write. Row shape from the
// monitor sheet: Date, Box, Adults, Eggs, Chicks, Bird-1, Sex-1, .. Bird-N, Sex-N, Notes.
//   - "Decom" in the Adults cell => observation with breeding_status DCM, zero counts.
//   - Bird cells hold chip/PIT numbers; matched last-8 against penguin_chips.pit_id.
//     A bird cell reading "no scan" is an unscanned adult (counts toward no_scan).
//   - Each Sex-N pairs with Bird-N: a chick size code (BC/LC/SC, validated against a
//     chick chipped in this box on this date) and/or an observed sex (M/UM/UF/F -> a
//     penguin_biometric_data sighting). penguins.sex is never modified.
//   - Adults exceeding entered birds implies no-scans, confirmed by the user at commit.
//   - Unmatched chips are reported, never auto-created; their scan is skipped.

function ww_normHeader($h) { return preg_replace('/[^a-z0-9]/', '', strtolower(trim((string)$h))); }

// Last-8 uppercased alphanumerics of a chip/tag number — same key importMonitor() uses.
function ww_chipKey($raw) { return strtoupper(substr(preg_replace('/[^A-Za-z0-9]/', '', (string)$raw), -8)); }

// Digits only — for near-match on hand-typed chip numbers.
function ww_digits($s) { return preg_replace('/\D+/', '', (string)$s); }

// All digit strings one edit away (substitution / adjacent transposition / insertion / deletion).
// Used to suggest the intended bird when a typed chip matches nothing — the classic transcription slip.
function ww_editNeighbors($d) {
    $out = []; $n = strlen($d);
    for ($i = 0; $i < $n; $i++) {
        $out[substr($d, 0, $i) . substr($d, $i + 1)] = true;                        // deletion
        for ($c = 0; $c <= 9; $c++) if ($d[$i] !== (string)$c)
            $out[substr($d, 0, $i) . $c . substr($d, $i + 1)] = true;               // substitution
        if ($i + 1 < $n && $d[$i] !== $d[$i + 1])
            $out[substr($d, 0, $i) . $d[$i + 1] . $d[$i] . substr($d, $i + 2)] = true; // transposition
    }
    for ($i = 0; $i <= $n; $i++) for ($c = 0; $c <= 9; $c++)
        $out[substr($d, 0, $i) . $c . substr($d, $i)] = true;                       // insertion
    return array_keys($out);
}

/**
 * Parse + validate a monitor CSV against a colony. Pure analysis: NO DB writes.
 * Returns the structure the analysis page renders and the commit step replays.
 */
function ww_parseImportCsv($pdo, $csv, $colonyId, $observerId, $filename) {
    $R = [
        'ok' => true, 'error' => null,
        'colony_id' => $colonyId, 'colony_name' => null, 'filename' => $filename,
        'headers' => null, 'rows' => [],
        'unmatched_chips' => [], 'unknown_boxes' => [],
        'date_min' => null, 'date_max' => null,
        'totals' => [
            'rows' => 0, 'importable' => 0, 'flagged' => 0, 'duplicates' => 0, 'error_rows' => 0,
            'decom' => 0, 'boxes' => 0, 'boxes_in_colony' => 0, 'boxes_missing' => 0,
            'adults' => 0, 'eggs' => 0, 'chicks' => 0,
            'no_scan' => 0, 'scans_matched' => 0, 'scans_unmatched' => 0,
            'biometrics' => 0, 'noscan_confirm' => 0,
        ],
    ];

    $cstmt = $pdo->prepare("SELECT colony_name FROM colonies WHERE colony_id = ?");
    $cstmt->execute([$colonyId]);
    $colonyName = $cstmt->fetchColumn();
    if ($colonyName === false) { $R['ok'] = false; $R['error'] = "Colony $colonyId not found"; return $R; }
    $R['colony_name'] = $colonyName;

    // Parse through a temp stream so quoted fields / embedded newlines are handled.
    $fh = fopen('php://temp', 'r+');
    fwrite($fh, $csv);
    rewind($fh);
    $records = [];
    while (($row = fgetcsv($fh)) !== false) $records[] = $row;
    fclose($fh);
    if (count($records) < 2) { $R['ok'] = false; $R['error'] = 'CSV has no data rows'; return $R; }

    $header = array_shift($records);
    $headerCount = count($header);
    // Column layout: Date, Box, Adults, Eggs, Chicks, Bird-1, Sex-1, Bird-2, Sex-2, ..., Notes.
    // Each Bird-N carries a chip / "no scan" / (empty); its paired Sex-N holds either a chick
    // size code (BC/LC/SC[+sex]) or an observed sex (M/UM/UF/F). No standalone "No scan" column
    // any more — an unscanned adult is a bird cell reading "no scan".
    $idx = []; $birdCols = []; $ignoredCols = [];
    $birdColByNum = []; $sexColByNum = [];
    foreach ($header as $i => $h) {
        $n = ww_normHeader($h);
        if ($n === 'date') $idx['date'] = $i;
        elseif ($n === 'box') $idx['box'] = $i;
        elseif ($n === 'adults' || $n === 'adult') $idx['adults'] = $i;
        elseif ($n === 'eggs' || $n === 'egg') $idx['eggs'] = $i;
        elseif ($n === 'chicks' || $n === 'chick') $idx['chicks'] = $i;
        elseif ($n === 'notes' || $n === 'note') $idx['notes'] = $i;
        elseif (preg_match('/^sex(\d+)$/', $n, $m)) $sexColByNum[(int)$m[1]] = $i;
        elseif (preg_match('/^bird(\d+)$/', $n, $m)) { $birdColByNum[(int)$m[1]] = $i; $birdCols[] = $i; }
        elseif (strpos($n, 'bird') === 0) $birdCols[] = $i; // unnumbered bird column
        elseif ($n !== '') $ignoredCols[] = trim((string)$h);
    }
    // Pair each numbered bird column with its like-numbered sex column: birdColIndex => sexColIndex.
    $sexColByBird = [];
    foreach ($birdColByNum as $num => $bi) if (isset($sexColByNum[$num])) $sexColByBird[$bi] = $sexColByNum[$num];
    $missing = [];
    foreach (['date', 'box', 'adults'] as $req) if (!isset($idx[$req])) $missing[] = $req;
    if ($missing) { $R['ok'] = false; $R['error'] = 'Missing required column(s): ' . implode(', ', $missing); return $R; }
    $R['headers'] = [
        'date' => $header[$idx['date']], 'box' => $header[$idx['box']], 'adults' => $header[$idx['adults']],
        'eggs' => isset($idx['eggs']) ? $header[$idx['eggs']] : null,
        'chicks' => isset($idx['chicks']) ? $header[$idx['chicks']] : null,
        'no_scan' => isset($idx['no_scan']) ? $header[$idx['no_scan']] : null,
        'notes' => isset($idx['notes']) ? $header[$idx['notes']] : null,
        'bird_columns' => array_values(array_map(function ($i) use ($header) { return $header[$i]; }, $birdCols)),
    ];

    // Lookups: this colony's locations, and every known chip.
    $locLookup = [];
    $lstmt = $pdo->prepare("SELECT location_id, location_name FROM observation_locations WHERE colony_id = ?");
    $lstmt->execute([$colonyId]);
    foreach ($lstmt->fetchAll() as $l) $locLookup[strtoupper($l['location_name'])] = (int)$l['location_id'];

    // Chip resolution scoped to THIS colony. Key = last-8 of pit_id; a CSV bird number is the
    // same 8-digit subset. A cell resolves only if the subset maps to exactly one bird (peng_num)
    // whose home colony is this one. Zero / many / another-colony all flag and skip the scan.
    $byKeyColony = [];   // key => ['pengs'=>[peng=>1], 'pit'=>first pit, 'active'=>active pit]
    $byKeyAny = [];      // key => [peng=>colony_id]  (all colonies — to spot foreign birds)
    $pengMeta = [];      // peng_num => ['sex'=>M/F/'', 'dead'=>bool]  (this colony)
    $pengFirstChip = []; // peng_num => earliest chip_date (YYYY-MM-DD)
    $pengActiveKey = []; // peng_num => last-8 of its active chip (to spot retired-tag scans)
    $pengChickSize = []; // peng_num => recorded chick_size_code (BC/LC/SC or '')
    $pengChips = [];     // peng_num => [['date'=>YYYY-MM-DD, 'box'=>UPPER], ...]  (chipping events)
    foreach ($pdo->query("SELECT pc.pit_id, pc.peng_num, pc.is_active, pc.chip_date, pc.chip_box, p.colony_id, p.sex, p.is_dead, p.chick_size_code
        FROM penguin_chips pc JOIN penguins p ON pc.peng_num = p.peng_num")->fetchAll() as $c) {
        $k = ww_chipKey($c['pit_id']);
        $byKeyAny[$k][$c['peng_num']] = (int)$c['colony_id'];
        if ((int)$c['colony_id'] !== $colonyId) continue;
        if (!isset($byKeyColony[$k])) $byKeyColony[$k] = ['pengs' => [], 'pit' => null, 'active' => null];
        $byKeyColony[$k]['pengs'][$c['peng_num']] = true;
        if ($byKeyColony[$k]['pit'] === null) $byKeyColony[$k]['pit'] = $c['pit_id'];
        if ($c['is_active']) { if ($byKeyColony[$k]['active'] === null) $byKeyColony[$k]['active'] = $c['pit_id']; $pengActiveKey[$c['peng_num']] = $k; }
        $pengMeta[$c['peng_num']] = ['sex' => strtoupper((string)($c['sex'] ?? '')), 'dead' => !empty($c['is_dead'])];
        $pengChickSize[$c['peng_num']] = strtoupper((string)($c['chick_size_code'] ?? ''));
        if (!empty($c['chip_date'])) {
            $pengChips[$c['peng_num']][] = ['date' => substr($c['chip_date'], 0, 10), 'box' => strtoupper(trim((string)($c['chip_box'] ?? '')))];
            if (!isset($pengFirstChip[$c['peng_num']]) || $c['chip_date'] < $pengFirstChip[$c['peng_num']])
                $pengFirstChip[$c['peng_num']] = substr($c['chip_date'], 0, 10);
        }
    }
    $prefix = getColonyPrefix($pdo, $colonyId);

    // Biometric sex guesses so a same-sex-pair check can use suspected sex too.
    // observed_sex codes: PM/MM/M => male, PF/MF/F => female, U ignored.
    $pengGuess = [];     // peng_num => ['m'=>n, 'f'=>n]
    foreach ($pdo->query("SELECT b.peng_num, b.observed_sex FROM penguin_biometric_data b
        JOIN penguins p ON b.peng_num = p.peng_num
        WHERE p.colony_id = " . (int)$colonyId . " AND (b.is_deleted = 0 OR b.is_deleted IS NULL)")->fetchAll() as $b) {
        $s = strtoupper((string)($b['observed_sex'] ?? ''));
        if ($s === 'PM' || $s === 'MM' || $s === 'M') $pengGuess[$b['peng_num']]['m'] = ($pengGuess[$b['peng_num']]['m'] ?? 0) + 1;
        elseif ($s === 'PF' || $s === 'MF' || $s === 'F') $pengGuess[$b['peng_num']]['f'] = ($pengGuess[$b['peng_num']]['f'] ?? 0) + 1;
    }
    // Effective sex per bird: confirmed if known, else the biometric lean (flagged unconfirmed).
    $effSex = function ($peng) use ($pengMeta, $pengGuess) {
        $s = $pengMeta[$peng]['sex'] ?? '';
        if ($s === 'M' || $s === 'F') return [$s, true];
        $g = $pengGuess[$peng] ?? [];
        $m = $g['m'] ?? 0; $f = $g['f'] ?? 0;
        if ($m > $f) return ['M', false];
        if ($f > $m) return ['F', false];
        return ['', false];
    };

    // First & last date each bird was ever seen in each box, to flag a bird whose ONLY sighting
    // in a box is this date — nothing before or after. Keyed location_id|peng_num => [min,max].
    $seenInBox = [];
    foreach ($pdo->query("SELECT o.location_id, o.observation_time_utc, pc.peng_num
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
        WHERE ol.colony_id = " . (int)$colonyId . " AND o.is_deleted = FALSE AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)")->fetchAll() as $h) {
        $nz = substr($h['observation_time_utc'], 0, 10); // day-level is enough for a before/after test
        $key = $h['location_id'] . '|' . $h['peng_num'];
        if (!isset($seenInBox[$key])) $seenInBox[$key] = ['min' => $nz, 'max' => $nz];
        else { if ($nz < $seenInBox[$key]['min']) $seenInBox[$key]['min'] = $nz; if ($nz > $seenInBox[$key]['max']) $seenInBox[$key]['max'] = $nz; }
    }

    $dupStmt = $pdo->prepare("SELECT observation_id FROM observations WHERE location_id = ? AND observation_time_utc = ? AND observer_id = ? AND is_deleted = FALSE");
    // Most recent existing observation in a box before the import instant — the row-click target.
    $prevStmt = $pdo->prepare("SELECT observation_time_utc FROM observations WHERE location_id = ? AND is_deleted = FALSE AND observation_time_utc < ? ORDER BY observation_time_utc DESC LIMIT 1");

    $parseInt = function ($v) {
        $v = trim((string)$v);
        if ($v === '') return [0, true];
        if (!preg_match('/^-?\d+$/', $v)) return [0, false];
        return [(int)$v, true];
    };

    // Parse a Sex-N cell into [sizeCode, observedSex, unknownToken].
    //   - Optional leading chick size code BC/LC/SC  -> validated against chick_size_code.
    //   - Remaining token is an observed sex, mapped to the biometric encoding:
    //       M->M, F->F (confirmed/legacy), UM->MM (maybe male), UF->MF (maybe female), U->U.
    //   observedSex '' = none; null = an unrecognised token (flagged, not stored).
    $parseSexCell = function ($raw) {
        $s = strtoupper(preg_replace('/[^A-Za-z]/', '', (string)$raw));
        $size = '';
        if (preg_match('/^(BC|LC|SC)(.*)$/', $s, $m)) { $size = $m[1]; $s = $m[2]; }
        static $sexMap = ['M' => 'M', 'F' => 'F', 'UM' => 'MM', 'UF' => 'MF', 'U' => 'U'];
        $obs = $s === '' ? '' : ($sexMap[$s] ?? null);
        return [$size, $obs, $s];
    };

    $unmatched = [];      // chipKey => ['chip'=>original, 'reason'=>why, 'count'=>n, 'boxes'=>[...]]
    $unknownBoxes = [];
    $seenBoxes = [];
    $distinctDates = [];
    $refDate = null;      // first data row's date — the sheet's expected single date
    $birdBoxes = [];      // "date|chipKey" => [['i'=>rowIndex, 'box'=>name], ...] — a bird can't be in two boxes at once
    $R['file_flags'] = [];
    $tzNz = new DateTimeZone('Pacific/Auckland');
    $tzUtc = new DateTimeZone('UTC');
    $today = (new DateTime('now', $tzNz))->format('Y-m-d');
    $prevBirdDigits = [];  // bird column index => previous row's digits (fill-drag detection)
    $prevDate = null;
    $sheetSeen = [];       // "locId|date" => first line seen (within-sheet duplicate box)
    $lineNo = 1;          // header consumed as line 1

    foreach ($records as $rec) {
        $lineNo++;
        if (!count(array_filter($rec, function ($v) { return trim((string)$v) !== ''; }))) continue; // blank line

        $R['totals']['rows']++;
        $box = trim((string)($rec[$idx['box']] ?? ''));
        $dateRaw = trim((string)($rec[$idx['date']] ?? ''));
        $adultsRaw = trim((string)($rec[$idx['adults']] ?? ''));
        $notes = isset($idx['notes']) ? trim((string)($rec[$idx['notes']] ?? '')) : '';
        $errors = []; $warnings = [];
        if (count($rec) !== $headerCount) $warnings[] = 'row has ' . count($rec) . " columns, expected $headerCount — misaligned?";

        // Box -> location
        $locId = null;
        if ($box === '') { $errors[] = 'Missing box'; }
        else {
            $locId = $locLookup[strtoupper($box)] ?? null;
            if ($locId === null) {
                $errors[] = "Unknown box '$box' — not a location in $colonyName";
                if (!in_array($box, $unknownBoxes, true)) $unknownBoxes[] = $box;
            }
            if (!in_array($box, $seenBoxes, true)) $seenBoxes[] = $box;
        }

        // Date -> observation_time. Year-first ONLY (YYYY-MM-DD, or / . space separators) so
        // DD/MM vs MM/DD can never be misread. Anything else is rejected and the row skipped.
        $obsDate = null;
        if (preg_match('/^(\d{4})[-\/. ](\d{1,2})[-\/. ](\d{1,2})$/', $dateRaw, $dm)
            && checkdate((int)$dm[2], (int)$dm[3], (int)$dm[1]))
            $obsDate = sprintf('%04d-%02d-%02d', (int)$dm[1], (int)$dm[2], (int)$dm[3]);
        if ($obsDate === null) $errors[] = "Invalid date '$dateRaw' (expected YYYY-MM-DD)";
        $obsTime = null;
        if ($obsDate) {
            $nzDt = new DateTime($obsDate . ' 14:00:00', $tzNz);
            $nzDt->setTimezone($tzUtc);
            $obsTime = $nzDt->format('Y-m-d H:i:s');
            $distinctDates[$obsDate] = true;
            if ($obsDate > $today) $warnings[] = "date $obsDate is in the future";
            if ($R['date_min'] === null || $obsDate < $R['date_min']) $R['date_min'] = $obsDate;
            if ($R['date_max'] === null || $obsDate > $R['date_max']) $R['date_max'] = $obsDate;
        }

        // Counts / Decom
        $isDecom = (bool)preg_match('/decom/i', $adultsRaw);
        $adults = 0; $eggs = 0; $chicks = 0; $noScan = 0; $breeding = null; $countsOk = true;
        if ($isDecom) {
            $breeding = 'DCM';
        } else {
            list($adults, $aOk) = $parseInt($adultsRaw);
            if (!$aOk) { $errors[] = "Adults '$adultsRaw' is not a number"; $countsOk = false; }
            if (isset($idx['eggs'])) { list($eggs, $ok) = $parseInt($rec[$idx['eggs']] ?? ''); if (!$ok) { $errors[] = 'Eggs is not a number'; $countsOk = false; } }
            if (isset($idx['chicks'])) { list($chicks, $ok) = $parseInt($rec[$idx['chicks']] ?? ''); if (!$ok) { $errors[] = 'Chicks is not a number'; $countsOk = false; } }
            if ($countsOk && $adults < 0) { $errors[] = 'Adults is negative'; $countsOk = false; }
        }

        // Column shift: an 8-digit chip-like value where a count/note belongs — the row slid sideways.
        foreach (['eggs' => 'Eggs', 'chicks' => 'Chicks', 'notes' => 'Notes'] as $ck => $lbl) {
            if (!isset($idx[$ck])) continue;
            $cell = trim((string)($rec[$idx[$ck]] ?? ''));
            if (preg_match('/^\d{8}$/', $cell)) $warnings[] = "$lbl column has a chip-like value ($cell) — shifted row?";
        }

        // Bird cells -> scans. A filled cell is a scan regardless of whether the chip resolves.
        // $miniPengs collects display peng_nums a flag refers to, so the report can show their minis.
        $scans = []; $unmatchedHere = []; $rowKeys = []; $rowSeen = []; $miniPengs = []; $bios = [];
        $addMini = function ($peng) use (&$miniPengs, $prefix) {
            $d = displayPengNum($peng, $prefix);
            if (!in_array($d, $miniPengs, true)) $miniPengs[] = $d;
        };
        if (!$isDecom) {
            foreach ($birdCols as $bi) {
                $val = trim((string)($rec[$bi] ?? ''));
                $sexRaw = isset($sexColByBird[$bi]) ? trim((string)($rec[$sexColByBird[$bi]] ?? '')) : '';
                if ($val === '') continue;
                // Inline "no scan" marker: an adult present but not scanned this visit. Its paired
                // Sex cell can't be attached to a bird, so it's ignored.
                if (preg_replace('/[^a-z]/', '', strtolower($val)) === 'noscan') { $noScan++; continue; }
                $key = ww_chipKey($val);
                // Same chip listed twice in one box — almost always a copy-paste. Flag, scan once.
                if (isset($rowSeen[$key])) {
                    $warnings[] = "chip $val listed more than once in this box";
                    $c2 = $byKeyColony[$key] ?? null;
                    if ($c2 && count($c2['pengs']) === 1) $addMini(array_key_first($c2['pengs']));
                    continue;
                }
                $rowSeen[$key] = true; $rowKeys[] = $key;
                $col = $byKeyColony[$key] ?? null;
                $nPeng = $col ? count($col['pengs']) : 0;
                if ($nPeng === 1) {
                    $pgR = array_key_first($col['pengs']);
                    $scans[] = ['pit_id' => $col['active'] ?? $col['pit'], 'chip' => $val, 'key' => $key, 'peng_num' => $pgR];
                    // Paired Sex cell: a chick size code (validated) and/or an observed sex (biometric).
                    if ($sexRaw !== '') {
                        list($size, $obsSex) = $parseSexCell($sexRaw);
                        if ($size !== '') {
                            // Validate the chick size code against the bird's recorded chick_size_code.
                            // Only a genuine conflict is flagged; a match — or no recorded size — passes
                            // quietly (chip_box is too unreliable to demand a same-box chipping).
                            $recorded = $pengChickSize[$pgR] ?? '';
                            if ($recorded !== '' && $recorded !== $size) {
                                $warnings[] = "chick size $size ≠ recorded $recorded for #" . displayPengNum($pgR, $prefix);
                                $addMini($pgR);
                            }
                        }
                        if ($obsSex === null) { $warnings[] = "unrecognised sex '$sexRaw' for #" . displayPengNum($pgR, $prefix); $addMini($pgR); }
                        elseif ($obsSex !== '') $bios[] = ['peng_num' => $pgR, 'observed_sex' => $obsSex];
                    }
                } else {
                    if ($nPeng > 1) $reason = "last-8 matches $nPeng birds in $colonyName";
                    elseif (isset($byKeyAny[$key])) $reason = 'belongs to another colony';
                    else $reason = "no bird in $colonyName";
                    $u = ['chip' => $val, 'reason' => $reason, 'suggest' => null, 'suggest_peng' => null, 'suggest_key' => null];
                    // Transcription near-match: a single colony bird one edit away from the typed number.
                    if ($nPeng === 0 && !isset($byKeyAny[$key])) {
                        $cand = [];
                        foreach (ww_editNeighbors(ww_digits($val)) as $nb)
                            if (isset($byKeyColony[$nb])) foreach (array_keys($byKeyColony[$nb]['pengs']) as $pg) $cand[$pg] = $nb;
                        if (count($cand) === 1) { $pg = array_key_first($cand); $u['suggest'] = displayPengNum($pg, $prefix); $u['suggest_peng'] = $pg; $u['suggest_key'] = $cand[$pg]; }
                    }
                    $unmatchedHere[] = $u;
                    if (!isset($unmatched[$key])) $unmatched[$key] = ['chip' => $val, 'reason' => $reason, 'suggest' => $u['suggest'], 'count' => 0, 'boxes' => []];
                    $unmatched[$key]['count']++;
                    if ($box !== '' && !in_array($box, $unmatched[$key]['boxes'], true)) $unmatched[$key]['boxes'][] = $box;
                }
            }
        }

        // ---- Flags: interesting/problematic but still importable (never exclude the row) ----
        $birdsListed = count($scans) + count($unmatchedHere); // "#scans" = every chip Bird cell
        $needNoScanConfirm = 0; // implied no-scans (adults not accounted for) awaiting confirmation
        if (!$isDecom) {
            // 1. Improbable counts for a little-penguin box.
            if ($adults > 2) $warnings[] = "adults = $adults (>2)";
            if (($eggs + $chicks) > 2) $warnings[] = 'eggs + chicks = ' . ($eggs + $chicks) . ' (>2)';
            // 2. Balance: adults should equal birds entered (chips + unmatched) + no-scan cells.
            //    Extra adults with no bird cell are unscanned — recorded as no-scans, but only after
            //    the user confirms at commit ($needNoScanConfirm carries the implied count).
            if ($countsOk && $adults > $birdsListed + $noScan) {
                $needNoScanConfirm = $adults - $birdsListed - $noScan;
                $noScan += $needNoScanConfirm;
                $warnings[] = "adults ($adults) > birds entered ($birdsListed) — confirm $needNoScanConfirm no-scan(s)";
            } elseif ($countsOk && $adults < $birdsListed + $noScan) {
                $warnings[] = "adults ($adults) < entered (" . ($birdsListed + $noScan) . ') — more entered than present';
            }
        }
        // 5. Chips that didn't resolve to exactly one colony bird (with a "did you mean" near-match).
        foreach ($unmatchedHere as $u) {
            $msg = "chip {$u['chip']}: {$u['reason']}";
            if (!empty($u['suggest'])) { $msg .= " — did you mean #{$u['suggest']} ({$u['suggest_key']})?"; $addMini($u['suggest_peng']); }
            $warnings[] = $msg;
        }
        // Per-scanned-bird checks.
        foreach ($scans as $sc) {
            $pg = $sc['peng_num'];
            // Retired tag: typed an old (inactive) chip when the bird has a newer active one.
            if (isset($pengActiveKey[$pg]) && $pengActiveKey[$pg] !== $sc['key']) {
                $warnings[] = "chip {$sc['chip']} is a retired tag for #" . displayPengNum($pg, $prefix) . " (active {$pengActiveKey[$pg]})";
                $addMini($pg);
            }
            // Scan dated before the bird was chipped.
            if ($obsDate && isset($pengFirstChip[$pg]) && $obsDate < $pengFirstChip[$pg]) {
                $warnings[] = "scanned $obsDate, before #" . displayPengNum($pg, $prefix) . " was chipped ({$pengFirstChip[$pg]})";
                $addMini($pg);
            }
            // Bird recorded dead in the database.
            if (!empty($pengMeta[$pg]['dead'])) { $warnings[] = 'recorded dead: #' . displayPengNum($pg, $prefix); $addMini($pg); }
        }
        // Two adults of the same sex (confirmed or suspected) — unusual for a breeding pair.
        if (!$isDecom && count($scans) >= 2) {
            $sexes = []; $known = 0; $anyGuess = false;
            foreach ($scans as $sc) {
                list($sx, $conf) = $effSex($sc['peng_num']);
                if ($sx !== '') { $sexes[$sx] = true; $known++; if (!$conf) $anyGuess = true; }
            }
            if ($known >= 2 && count($sexes) === 1) {
                $warnings[] = 'two ' . (array_key_first($sexes) === 'M' ? 'male' : 'female') . ' adults' . ($anyGuess ? ' (incl. suspected)' : '');
                foreach ($scans as $sc) $addMini($sc['peng_num']);
            }
        }
        // 3. Bird whose only sighting in this box is this date — none before or after.
        if ($obsDate && $locId !== null) {
            foreach ($scans as $sc) {
                $s = $seenInBox[$locId . '|' . $sc['peng_num']] ?? null;
                $seenOtherDate = $s && ($s['min'] < $obsDate || $s['max'] > $obsDate);
                if (!$seenOtherDate) {
                    $warnings[] = 'only ever in this box on this date: #' . displayPengNum($sc['peng_num'], $prefix);
                    $addMini($sc['peng_num']);
                }
            }
        }
        // Spreadsheet fill-down: a bird number exactly +1 from the row above (same column),
        // or a date exactly one day later — drag-handle artifacts, not real observations.
        $curBirdDigits = [];
        foreach ($birdCols as $bi) {
            $dg = ww_digits(trim((string)($rec[$bi] ?? '')));
            if ($dg === '') continue;
            $curBirdDigits[$bi] = $dg;
            if (isset($prevBirdDigits[$bi]) && strlen($dg) === 8 && strlen($prevBirdDigits[$bi]) === 8
                && (int)$dg === (int)$prevBirdDigits[$bi] + 1)
                $warnings[] = "chip $dg is +1 from the row above — spreadsheet fill-down?";
        }
        if ($obsDate && $prevDate) {
            $pd = date_create($prevDate);
            if ($pd && $pd->modify('+1 day')->format('Y-m-d') === $obsDate) $warnings[] = 'date is +1 day from the row above — fill-down?';
        }
        $prevBirdDigits = $curBirdDigits;
        if ($obsDate) $prevDate = $obsDate;

        // 6. Date consistency — a monitor sheet should be one day.
        if ($obsDate) {
            if ($refDate === null) $refDate = $obsDate;
            elseif ($obsDate !== $refDate) $warnings[] = "date $obsDate differs from $refDate";
        }

        // Duplicate check (same box + date + this observer, not deleted)
        $duplicate = false;
        if ($locId !== null && $obsTime !== null) {
            $dupStmt->execute([$locId, $obsTime, $observerId]);
            if ($dupStmt->fetchColumn()) $duplicate = true;
        }
        // Within-sheet duplicate: same box+date appears earlier in THIS file. Skip the repeat
        // (the DB check can't catch it — neither row is in the DB yet at analyse time).
        $sheetDupOf = null;
        if ($locId !== null && $obsDate !== null) {
            $sk = $locId . '|' . $obsDate;
            if (isset($sheetSeen[$sk])) $sheetDupOf = $sheetSeen[$sk];
            else $sheetSeen[$sk] = $lineNo;
        }
        // Row-click target: most recent existing observation in this box before the import.
        $prevObs = null;
        if ($locId !== null && $obsTime !== null) {
            $prevStmt->execute([$locId, $obsTime]);
            $pv = $prevStmt->fetchColumn();
            if ($pv !== false) $prevObs = $pv;
        }

        if ($sheetDupOf !== null) $warnings[] = "duplicate of line $sheetDupOf in this sheet (same box + date)";
        $status = count($errors) ? 'error' : (($duplicate || $sheetDupOf !== null) ? 'duplicate' : 'ok');
        $R['rows'][] = [
            'line' => $lineNo, 'box' => $box, 'date' => $obsDate, 'location_id' => $locId,
            'adults' => $adults, 'eggs' => $eggs, 'chicks' => $chicks, 'no_scan' => $noScan,
            'confirm_no_scan' => $needNoScanConfirm, 'bios' => $bios,
            'breeding_status' => $breeding, 'is_decom' => $isDecom, 'notes' => $notes,
            'obs_time' => $obsTime, 'prev_obs' => $prevObs, 'scans' => $scans, 'unmatched' => $unmatchedHere,
            'errors' => $errors, 'warnings' => $warnings, 'mini_pengs' => $miniPengs, 'status' => $status,
        ];
        // Track each scanned chip's box per day so we can flag a bird appearing in two boxes.
        if ($obsDate && $rowKeys) {
            $ri = count($R['rows']) - 1;
            foreach ($rowKeys as $k) $birdBoxes[$obsDate . '|' . $k][] = ['i' => $ri, 'box' => $box];
        }

        if ($status === 'error') { $R['totals']['error_rows']++; continue; }
        if ($status === 'duplicate') { $R['totals']['duplicates']++; continue; }
        // Importable row — tally what would actually be written.
        $R['totals']['importable']++;
        if (count($warnings)) $R['totals']['flagged']++;
        if ($isDecom) $R['totals']['decom']++;
        $R['totals']['adults'] += $adults; $R['totals']['eggs'] += $eggs; $R['totals']['chicks'] += $chicks;
        $R['totals']['no_scan'] += $noScan; $R['totals']['scans_matched'] += count($scans);
        $R['totals']['scans_unmatched'] += count($unmatchedHere);
        $R['totals']['biometrics'] += count($bios);
        if ($needNoScanConfirm > 0) $R['totals']['noscan_confirm']++;
    }

    if (count($distinctDates) > 1) {
        $dl = array_keys($distinctDates); sort($dl);
        $R['file_flags'][] = 'Sheet spans multiple dates: ' . implode(', ', $dl);
    }
    if ($ignoredCols) $R['file_flags'][] = 'Ignored columns (not imported): ' . implode(', ', $ignoredCols);

    // Coverage: colony boxes absent from this sheet (is it a full monitor or a partial?).
    $present = [];
    foreach ($seenBoxes as $b) $present[strtoupper($b)] = true;
    $missing = [];
    foreach ($locLookup as $up => $lid) if (!isset($present[$up])) $missing[] = $up;
    sort($missing, SORT_NATURAL);
    $R['totals']['boxes_in_colony'] = count($locLookup);
    $R['totals']['boxes_missing'] = count($missing);
    $R['coverage_missing'] = $missing;
    if ($missing) $R['file_flags'][] = count($missing) . ' of ' . count($locLookup) . ' colony boxes not in this sheet';

    // A bird scanned in two different boxes on the same day can't be right — flag every box.
    foreach ($birdBoxes as $dk => $entries) {
        $boxes = [];
        foreach ($entries as $e) if (!in_array($e['box'], $boxes, true)) $boxes[] = $e['box'];
        if (count($boxes) < 2) continue;
        $chip = substr($dk, strpos($dk, '|') + 1);
        $cc = $byKeyColony[$chip] ?? null;
        $disp = ($cc && count($cc['pengs']) === 1) ? displayPengNum(array_key_first($cc['pengs']), $prefix) : null;
        foreach ($entries as $e) {
            $others = [];
            foreach ($boxes as $b) if ($b !== $e['box']) $others[] = $b;
            $row = &$R['rows'][$e['i']];
            $had = count($row['warnings']) > 0;
            $row['warnings'][] = "chip $chip also in box " . implode(', ', $others) . ' this day';
            if ($disp !== null && !in_array($disp, $row['mini_pengs'], true)) $row['mini_pengs'][] = $disp;
            if ($row['status'] === 'ok' && !$had) $R['totals']['flagged']++;
            unset($row);
        }
    }

    $R['totals']['boxes'] = count($seenBoxes);
    $R['unknown_boxes'] = $unknownBoxes;
    $R['unmatched_chips'] = array_values($unmatched);
    usort($R['unmatched_chips'], function ($a, $b) { return $b['count'] - $a['count']; });
    return $R;
}

// Read {csv, filename, colony_id} from the request body.
function ww_importInput() {
    $in = json_decode(file_get_contents('php://input'), true) ?? [];
    $csv = (string)($in['csv'] ?? '');
    // Keep the filename as-is (incl. extension) — it becomes the day's monitor label, e.g. "FM-19 2024.csv".
    $filename = basename(trim((string)($in['filename'] ?? 'import.csv')));
    $colonyId = (int)($in['colony_id'] ?? 0);
    return [$csv, $filename, $colonyId];
}

if ($action === 'import_csv_analyze') {
    list($csv, $filename, $colonyId) = ww_importInput();
    if ($csv === '') { http_response_code(400); echo json_encode(['error' => 'No CSV supplied']); exit; }
    if (!$colonyId) { http_response_code(400); echo json_encode(['error' => 'colony_id required']); exit; }
    echo json_encode(ww_parseImportCsv($pdo, $csv, $colonyId, (int)$observer['observer_id'], $filename));
    exit;
}

if ($action === 'import_csv_commit') {
    list($csv, $filename, $colonyId) = ww_importInput();
    if ($csv === '') { http_response_code(400); echo json_encode(['error' => 'No CSV supplied']); exit; }
    if (!$colonyId) { http_response_code(400); echo json_encode(['error' => 'colony_id required']); exit; }
    $observerId = (int)$observer['observer_id'];

    // Re-parse so what we write is exactly what was validated (DB may have shifted since analyze).
    $A = ww_parseImportCsv($pdo, $csv, $colonyId, $observerId, $filename);
    if (!$A['ok']) { http_response_code(400); echo json_encode(['error' => $A['error']]); exit; }

    $imported = 0; $scans = 0; $bios = 0; $skippedDup = 0; $skippedErr = 0;
    try {
        $pdo->beginTransaction();
        $insObs = $pdo->prepare("INSERT INTO observations (location_id, observer_id, observation_time_utc, adults, eggs, chicks, no_scan, breeding_status, notes, monitor_filename) VALUES (?,?,?,?,?,?,?,?,?,?)");
        $insScan = $pdo->prepare("INSERT INTO penguin_scans (observation_id, pit_id, scan_time_utc) VALUES (?,?,?)");
        $insBio = $pdo->prepare("INSERT INTO penguin_biometric_data (peng_num, observation_id, observation_date, observed_sex) VALUES (?,?,?,?)");
        // Skip a biometric if this bird already has a live one on this date (idempotent re-imports).
        $dupBio = $pdo->prepare("SELECT 1 FROM penguin_biometric_data WHERE peng_num = ? AND observation_date = ? AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1");
        foreach ($A['rows'] as $row) {
            if ($row['status'] === 'error') { $skippedErr++; continue; }
            if ($row['status'] === 'duplicate') { $skippedDup++; continue; }
            $insObs->execute([
                $row['location_id'], $observerId, $row['obs_time'],
                $row['adults'], $row['eggs'], $row['chicks'], $row['no_scan'],
                $row['breeding_status'], $row['notes'], $A['filename'],
            ]);
            $obsId = $pdo->lastInsertId();
            $imported++;
            foreach ($row['scans'] as $sc) {
                $insScan->execute([$obsId, $sc['pit_id'], $row['obs_time']]);
                $scans++;
            }
            foreach ($row['bios'] ?? [] as $b) {
                $dupBio->execute([$b['peng_num'], $row['date']]);
                if ($dupBio->fetchColumn()) continue;
                $insBio->execute([$b['peng_num'], $obsId, $row['date'], $b['observed_sex']]);
                $bios++;
            }
        }
        $pdo->commit();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['error' => 'Import failed: ' . $e->getMessage()]);
        exit;
    }

    echo json_encode([
        'success' => true, 'filename' => $A['filename'], 'colony_id' => $colonyId, 'colony_name' => $A['colony_name'],
        'imported' => $imported, 'scans' => $scans, 'biometrics' => $bios, 'skipped_duplicates' => $skippedDup, 'skipped_errors' => $skippedErr,
        'unmatched_chips' => $A['unmatched_chips'],
    ]);
    exit;
}

echo json_encode(['error'=>'Unknown action']);
