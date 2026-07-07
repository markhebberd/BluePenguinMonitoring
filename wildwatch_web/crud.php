<?php
/**
 * Audited CRUD API with session-based observer auth and role-based access.
 *
 * POST ?action=login     - {email, password} -> token, role
 * POST ?action=register  - {name, email, password} (restricted emails only)
 *
 * All other actions require Authorization: Bearer <token>
 * GET    ?action=list&table=X[&field=val]
 * GET    ?action=get&table=X&id=N
 * GET    ?action=history&table=X&id=N  - audit log for a record
 * POST   ?action=create&table=X  (JSON body) [editor+]
 * POST   ?action=update&table=X&id=N  (JSON body) [editor+]
 * POST   ?action=delete&table=X&id=N  [editor+, soft delete for observations]
 */
require_once 'config.php';

header('Content-Type: application/json');
header('Cache-Control: no-cache');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();

// Ensure sessions table
$pdo->exec("CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY,
    observer_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (observer_id) REFERENCES observers(observer_id)
)");

$action = $_GET['action'] ?? '';

if ($action === 'login') { handleLogin($pdo); exit; }
if ($action === 'register') { handleRegister($pdo); exit; }
// Set-password flow (unauthenticated by design: the emailed token IS the credential)
if ($action === 'request_password_reset') { handleRequestPasswordReset($pdo); exit; }
if ($action === 'check_reset_token') { handleCheckResetToken($pdo); exit; }
if ($action === 'reset_password') { handleResetPassword($pdo); exit; }

$observer = authenticate($pdo);
if (!$observer) { http_response_code(401); echo json_encode(['error' => 'Not authenticated']); exit; }

// Season field-monitoring dates — read (GET) and write (POST)
if ($action === 'season_fm_dates' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    $seasonInput = $_GET['season'] ?? '';
    $season = strlen($seasonInput) === 2 ? 2000 + intval($seasonInput) : intval($seasonInput);
    if (!$season) { echo json_encode(['error' => 'season required']); exit; }
    $stmt = $pdo->prepare("SELECT date_number, actual_date, partial_monitor FROM date_mappings WHERE season_year = ? ORDER BY date_number");
    $stmt->execute([$season]);
    echo json_encode($stmt->fetchAll());
    exit;
}

// All registered FM dates across every season — lets the app flag FM dates app-wide
if ($action === 'all_fm_dates' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = $pdo->query("SELECT season_year, date_number, actual_date, partial_monitor FROM date_mappings ORDER BY actual_date");
    echo json_encode($stmt->fetchAll());
    exit;
}

if ($action === 'change_password') { handleChangePassword($pdo, $observer); exit; }

$table = $_GET['table'] ?? '';
$id = $_GET['id'] ?? null;

$tables = [
    'observations' => 'observation_id',
    'penguins' => 'peng_num',
    'penguin_scans' => 'scan_id',
    'penguin_biometric_data' => 'biometric_id',
    'penguin_chips' => 'pit_id',
    'observation_locations' => 'location_id',
];

if ($action === 'history') { handleHistory($pdo, $table, $id); exit; }
if ($action === 'me') { echo json_encode(['name'=>$observer['observer_name'], 'role'=>$observer['role'] ?? 'viewer']); exit; }

// Season field-monitoring dates — write (POST) requires auth
if ($action === 'season_fm_dates') {
    $seasonInput = $_GET['season'] ?? '';
    $season = strlen($seasonInput) === 2 ? 2000 + intval($seasonInput) : intval($seasonInput);
    if (!$season) { echo json_encode(['error' => 'season required']); exit; }
    // $canWrite isn't computed until the CRUD section below, so check the role here.
    $fmRole = $observer['role'] ?? 'viewer';
    if ($fmRole !== 'admin' && $fmRole !== 'editor') { http_response_code(403); echo json_encode(['error'=>'Write access required']); exit; }

    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !is_array($input)) { http_response_code(400); echo json_encode(['error'=>'JSON array required']); exit; }

    $oldStmt = $pdo->prepare("SELECT date_number, actual_date, partial_monitor FROM date_mappings WHERE season_year = ? ORDER BY date_number");
    $oldStmt->execute([$season]);
    $oldMappings = $oldStmt->fetchAll();

    $pdo->beginTransaction();
    try {
        $pdo->prepare("DELETE FROM date_mappings WHERE season_year = ?")->execute([$season]);
        $stmt = $pdo->prepare("INSERT INTO date_mappings (season_year, date_number, actual_date, partial_monitor) VALUES (?, ?, ?, ?)");
        foreach ($input as $row) {
            $stmt->execute([$season, $row['n'], $row['date'], !empty($row['partial']) ? 1 : 0]);
        }
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('date_mappings', ?, 'UPDATE', ?, ?)")
            ->execute([$season, $observer['observer_id'], json_encode([
                'season' => $season, 'old' => $oldMappings, 'new' => $input
            ])]);
        $pdo->commit();
        echo json_encode(['success'=>true, 'count'=>count($input)]);
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(400); echo json_encode(['error'=>$e->getMessage()]);
    }
    exit;
}

if (!in_array($action, ['list','get','create','update','delete'])) { echo json_encode(['error'=>'Invalid action']); exit; }
if (!isset($tables[$table])) { echo json_encode(['error'=>'Invalid table']); exit; }

$pk = $tables[$table];
$role = $observer['role'] ?? 'viewer';

// API role: can only read penguins, read/write observation_locations
$apiWriteTables = ['observation_locations'];
$apiReadTables = ['penguins', 'penguin_chips', 'observation_locations'];

$canRead = ($role !== 'api') || in_array($table, $apiReadTables);
$canWrite = ($role === 'admin' || $role === 'editor') || ($role === 'api' && in_array($table, $apiWriteTables));

switch ($action) {
    case 'list':
    case 'get':
        if (!$canRead) { http_response_code(403); echo json_encode(['error'=>'Access denied']); break; }
        $action === 'list' ? handleList($pdo, $table) : handleGet($pdo, $table, $pk, $id);
        break;
    case 'create':
    case 'update':
    case 'delete':
        if (!$canWrite) { http_response_code(403); echo json_encode(['error'=>'Editors only']); break; }
        requireWriteColony($pdo, $observer, $table, $id, json_decode(file_get_contents('php://input'), true) ?: []);
        if ($action === 'create') handleCreate($pdo, $table, $pk, $observer);
        elseif ($action === 'update') handleUpdate($pdo, $table, $pk, $id, $observer);
        else handleDelete($pdo, $table, $pk, $id, $observer);
        break;
}

/**
 * Resolve the colony a CRUD write targets and require edit access to it. Colony-scoped
 * tables only (observations/scans/biometrics via the observation's location, and
 * observation_locations directly). Global tables (penguins, penguin_chips) aren't
 * colony-scoped, so they keep the global-role gate already applied above.
 */
function requireWriteColony($pdo, $observer, $table, $id, $input) {
    $col = function($sql, $arg) use ($pdo) { $s = $pdo->prepare($sql); $s->execute([$arg]); return $s->fetchColumn(); };
    $colonyId = null;
    if ($table === 'observation_locations') {
        $colonyId = $id ? $col("SELECT colony_id FROM observation_locations WHERE location_id = ?", $id)
                        : ($input['colony_id'] ?? null);
    } elseif ($table === 'observations') {
        $locId = $id ? $col("SELECT location_id FROM observations WHERE observation_id = ?", $id)
                     : ($input['location_id'] ?? null);
        if ($locId) $colonyId = $col("SELECT colony_id FROM observation_locations WHERE location_id = ?", $locId);
    } elseif ($table === 'penguin_scans' || $table === 'penguin_biometric_data') {
        $pk = $table === 'penguin_scans' ? 'scan_id' : 'biometric_id';
        $obsId = $id ? $col("SELECT observation_id FROM $table WHERE $pk = ?", $id)
                     : ($input['observation_id'] ?? null);
        if ($obsId) {
            $locId = $col("SELECT location_id FROM observations WHERE observation_id = ?", $obsId);
            if ($locId) $colonyId = $col("SELECT colony_id FROM observation_locations WHERE location_id = ?", $locId);
        }
    }
    if ($colonyId !== null) requireColonyAccess($pdo, $observer, (int)$colonyId, true);
}

function handleLogin($pdo) {
    $input = json_decode(file_get_contents('php://input'), true);
    $email = $input['email'] ?? '';
    $password = $input['password'] ?? '';

    $stmt = $pdo->prepare("SELECT * FROM observers WHERE email = ?");
    $stmt->execute([$email]);
    $rows = $stmt->fetchAll();

    $observer = null;
    foreach ($rows as $row) {
        if (password_verify($password, $row['passphrase_hash'])) { $observer = $row; break; }
    }
    if (!$observer) { http_response_code(401); echo json_encode(['error'=>'Invalid credentials']); return; }

    $token = bin2hex(random_bytes(32));
    $expires = date('Y-m-d H:i:s', time() + 86400 * 30);
    $pdo->prepare("INSERT INTO sessions (token, observer_id, expires_at) VALUES (?, ?, ?)")
        ->execute([$token, $observer['observer_id'], $expires]);

    echo json_encode([
        'token'=>$token,
        'observer_id'=>$observer['observer_id'],
        'name'=>$observer['observer_name'],
        'email'=>$observer['email'],
        'role'=>$observer['role'] ?? 'viewer',
        'expires'=>$expires
    ]);
}

function handleRegister($pdo) {
    $allowed = ['markhebberd@gmail.com', 'bdot@snotch.com'];
    $input = json_decode(file_get_contents('php://input'), true);
    $name = trim($input['name'] ?? '');
    $email = trim($input['email'] ?? '');
    $password = $input['password'] ?? '';

    if (!in_array(strtolower($email), $allowed)) {
        http_response_code(403); echo json_encode(['error'=>'Registration not allowed for this email']); return;
    }
    if (empty($name) || empty($email) || strlen($password) < 6) {
        http_response_code(400); echo json_encode(['error'=>'Name, email, and password (6+ chars) required']); return;
    }

    $hash = password_hash($password, PASSWORD_BCRYPT);
    try {
        $pdo->prepare("INSERT INTO observers (observer_name, email, passphrase_hash, role) VALUES (?, ?, ?, 'editor')")
            ->execute([$name, $email, $hash]);
        echo json_encode(['success'=>true, 'observer_id'=>$pdo->lastInsertId()]);
    } catch (Exception $e) {
        http_response_code(409); echo json_encode(['error'=>'Name or email already exists']);
    }
}

/** Forgot password: email a 1-hour set-password link. Always answers success so the
 *  endpoint can't be used to probe which emails have accounts. */
function handleRequestPasswordReset($pdo) {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $email = trim($input['email'] ?? '');
    if ($email !== '') {
        $stmt = $pdo->prepare("SELECT * FROM observers WHERE email = ?");
        $stmt->execute([$email]);
        foreach ($stmt->fetchAll() as $observer) {
            // Replace any outstanding reset links (invites keep their longer validity)
            $pdo->prepare("DELETE FROM password_resets WHERE observer_id = ? AND purpose = 'reset' AND used_at IS NULL")
                ->execute([$observer['observer_id']]);
            sendPasswordSetupEmail($pdo, $observer, 'reset');
        }
    }
    echo json_encode(['success' => true, 'message' => 'If that email has an account, a reset link has been sent.']);
}

/** Look up a live (unused, unexpired) set-password token. */
function findResetToken($pdo, $token) {
    if ($token === '') return null;
    $stmt = $pdo->prepare("SELECT pr.*, o.observer_name, o.email FROM password_resets pr
        JOIN observers o ON o.observer_id = pr.observer_id
        WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW()");
    $stmt->execute([hash('sha256', $token)]);
    return $stmt->fetch() ?: null;
}

/** Validate an emailed token so the set-password page can greet the user. */
function handleCheckResetToken($pdo) {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $row = findResetToken($pdo, (string)($input['token'] ?? ''));
    if (!$row) { http_response_code(400); echo json_encode(['error' => 'This link is invalid or has expired.']); return; }
    echo json_encode(['valid' => true, 'observer_name' => $row['observer_name'], 'purpose' => $row['purpose']]);
}

/** Set a new password via an emailed token, then log the user straight in. All other
 *  sessions are dropped (a reset must lock out whoever had the old password). */
function handleResetPassword($pdo) {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $row = findResetToken($pdo, (string)($input['token'] ?? ''));
    $newPass = (string)($input['password'] ?? '');
    if (!$row) { http_response_code(400); echo json_encode(['error' => 'This link is invalid or has expired.']); return; }
    if (strlen($newPass) < 6) { http_response_code(400); echo json_encode(['error' => 'Password must be at least 6 characters']); return; }

    $hash = password_hash($newPass, PASSWORD_BCRYPT);
    $pdo->prepare("UPDATE observers SET passphrase_hash = ? WHERE observer_id = ?")->execute([$hash, $row['observer_id']]);
    $pdo->prepare("UPDATE password_resets SET used_at = NOW() WHERE token_hash = ?")->execute([$row['token_hash']]);
    $pdo->prepare("DELETE FROM sessions WHERE observer_id = ?")->execute([$row['observer_id']]);
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES ('observers', ?, 'UPDATE', ?, ?)")
        ->execute([$row['observer_id'], $row['observer_id'], json_encode(['passphrase_hash' => '(set via ' . $row['purpose'] . ' link)'])]);

    $stmt = $pdo->prepare("SELECT * FROM observers WHERE observer_id = ?");
    $stmt->execute([$row['observer_id']]);
    $observer = $stmt->fetch();
    $token = bin2hex(random_bytes(32));
    $expires = date('Y-m-d H:i:s', time() + 86400 * 30);
    $pdo->prepare("INSERT INTO sessions (token, observer_id, expires_at) VALUES (?, ?, ?)")
        ->execute([$token, $observer['observer_id'], $expires]);
    echo json_encode([
        'token' => $token,
        'observer_id' => $observer['observer_id'],
        'name' => $observer['observer_name'],
        'email' => $observer['email'],
        'role' => $observer['role'] ?? 'viewer',
        'expires' => $expires
    ]);
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

function handleList($pdo, $table) {
    $where = []; $params = [];
    foreach ($_GET as $k => $v) {
        if (in_array($k, ['action','table','colony_id'])) continue;
        // nz_date=YYYY-MM-DD on observations: rows whose NZ day (fixed +12,
        // matching the app's toNzDateStr bucketing) is that date.
        if ($k === 'nz_date' && $table === 'observations') {
            $dayStartUtc = strtotime($v . ' 00:00:00 UTC') - 12 * 3600;
            $where[] = "observation_time_utc >= ?"; $params[] = gmdate('Y-m-d H:i:s', $dayStartUtc);
            $where[] = "observation_time_utc < ?";  $params[] = gmdate('Y-m-d H:i:s', $dayStartUtc + 24 * 3600);
            continue;
        }
        if ($k === 'peng_num' && !preg_match('/^[A-Z]/', $v)) {
            $cid = (int)($_GET['colony_id'] ?? 1);
            $v = dbPengNum($pdo, $cid, $v);
        }
        $where[] = "$k = ?"; $params[] = $v;
    }
    $sql = "SELECT * FROM $table";
    if ($where) $sql .= " WHERE " . implode(' AND ', $where);
    $limit = ($table === 'observation_locations' || $table === 'penguins' || $table === 'penguin_chips' || $table === 'penguin_biometric_data' || isset($_GET['nz_date'])) ? 5000 : 100;
    $sql .= " ORDER BY 1 DESC LIMIT $limit";
    $stmt = $pdo->prepare($sql); $stmt->execute($params);
    $rows = $stmt->fetchAll();
    if (in_array($table, ['penguins', 'penguin_chips', 'penguin_biometric_data']))
        stripPengPrefix($rows, getColonyPrefix($pdo, (int)($_GET['colony_id'] ?? 1)));
    echo json_encode($rows);
}

function handleGet($pdo, $table, $pk, $id) {
    if (!$id) { echo json_encode(['error'=>'id required']); return; }
    if ($table === 'penguins' && !preg_match('/^[A-Z]/', $id)) {
        $cid = (int)($_GET['colony_id'] ?? 1);
        $id = dbPengNum($pdo, $cid, $id);
    }
    $stmt = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?"); $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) { http_response_code(404); echo json_encode(['error'=>'Not found']); return; }
    if (isset($row['peng_num'])) $row['peng_num'] = displayPengNum($row['peng_num'], getColonyPrefix($pdo, (int)($_GET['colony_id'] ?? 1)));
    echo json_encode($row);
}

/**
 * Drop retired columns from a write payload so older clients (e.g. a nestcheck build
 * still sending removed biometric condition fields) don't error after the columns are
 * dropped from the table.
 */
function stripRetiredColumns($table, $input) {
    $retired = [
        'penguin_biometric_data' => ['condition_underweight', 'condition_dog_attacked', 'condition_attacked', 'condition_dead'],
        'penguins' => ['life_stage', 'is_dead'], // is_dead is a generated column (derived from death_date)
    ];
    if (isset($retired[$table]) && is_array($input)) {
        foreach ($retired[$table] as $col) unset($input[$col]);
    }
    return $input;
}

function handleCreate($pdo, $table, $pk, $observer) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { http_response_code(400); echo json_encode(['error'=>'JSON body required']); return; }
    $input = stripRetiredColumns($table, $input);

    $cid = (int)($_GET['colony_id'] ?? 1);
    $viewPrefix = getColonyPrefix($pdo, $cid);
    $pdo->beginTransaction();
    try {
        // Prevent duplicate penguin scans for same observation
        if ($table === 'penguin_scans' && isset($input['observation_id']) && isset($input['pit_id'])) {
            $dup = $pdo->prepare("SELECT scan_id FROM penguin_scans WHERE observation_id = ? AND pit_id = ? AND (is_deleted = FALSE OR is_deleted IS NULL)");
            $dup->execute([$input['observation_id'], $input['pit_id']]);
            if ($dup->fetch()) {
                $pdo->rollBack();
                echo json_encode(['success' => false, 'error' => 'Penguin already scanned for this observation']);
                return;
            }
        }

        // Prevent duplicate chips
        if ($table === 'penguin_chips' && isset($input['pit_id'])) {
            $dup = $pdo->prepare("SELECT peng_num FROM penguin_chips WHERE pit_id = ?");
            $dup->execute([$input['pit_id']]);
            $existing = $dup->fetch();
            if ($existing) {
                $pdo->rollBack();
                echo json_encode(['success' => false, 'error' => "pit_id already assigned to penguin #" . displayPengNum($existing['peng_num'], $viewPrefix), 'peng_num' => displayPengNum($existing['peng_num'], $viewPrefix)]);
                return;
            }
        }

        // Auto-generate peng_num for new penguins (next number in the requested colony)
        if ($table === 'penguins' && !isset($input['peng_num'])) {
            $stmt = $pdo->prepare("SELECT MAX(CAST(REGEXP_REPLACE(peng_num, '^[A-Z]+', '') AS UNSIGNED)) FROM penguins WHERE colony_id = ?");
            $stmt->execute([$cid]);
            $input['peng_num'] = $viewPrefix . (string)((int)$stmt->fetchColumn() + 1);
        }
        // New penguins are stamped with their home colony
        if ($table === 'penguins' && !isset($input['colony_id'])) {
            $input['colony_id'] = $cid;
        }
        // Prepend colony prefix to bare peng_num on penguin/chip/bio creates
        if (in_array($table, ['penguins', 'penguin_chips', 'penguin_biometric_data']) && isset($input['peng_num'])) {
            $input['peng_num'] = dbPengNum($pdo, $cid, $input['peng_num']);
        }
        $newId = wwAuditedInsert($pdo, $table, $input, $observer['observer_id']);
        // For penguins, use peng_num as the ID since it's not auto-increment
        $recordId = ($table === 'penguins' && isset($input['peng_num'])) ? $input['peng_num'] : $newId;
        $pdo->commit();
        $result = ['success'=>true, 'id'=>$recordId];
        // Return the full inserted row so callers get auto-generated fields (e.g. peng_num)
        $row = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?");
        $row->execute([$recordId]);
        $inserted = $row->fetch();
        if ($inserted) {
            if (isset($inserted['peng_num'])) $inserted['peng_num'] = displayPengNum($inserted['peng_num'], $viewPrefix);
            $result = array_merge($result, $inserted);
        }
        if (isset($result['id']) && is_string($result['id'])) $result['id'] = displayPengNum($result['id'], $viewPrefix);
        echo json_encode($result);
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(400); echo json_encode(['error'=>$e->getMessage()]); }
}

function handleUpdate($pdo, $table, $pk, $id, $observer) {
    if (!$id) { http_response_code(400); echo json_encode(['error'=>'id required']); return; }
    // Prepend colony prefix for penguin-keyed tables
    if ($table === 'penguins' && !preg_match('/^[A-Z]/', $id)) {
        $cid = (int)($_GET['colony_id'] ?? 1);
        $id = dbPengNum($pdo, $cid, $id);
    }
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { http_response_code(400); echo json_encode(['error'=>'JSON body required']); return; }
    $input = stripRetiredColumns($table, $input);

    $stmt = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?"); $stmt->execute([$id]);
    $old = $stmt->fetch();
    if (!$old) { http_response_code(404); echo json_encode(['error'=>'Not found']); return; }

    $reason = $input['_reason'] ?? null;
    $sets = []; $params = []; $changed = [];
    foreach ($input as $col => $newVal) {
        if ($col === '_reason') continue;
        $sets[] = "$col = ?"; $params[] = $newVal;
        if (($old[$col] ?? null) != $newVal) $changed[$col] = ['old'=>$old[$col] ?? null, 'new'=>$newVal];
    }
    if (empty($changed)) { echo json_encode(['success'=>true, 'changed'=>0]); return; }
    $params[] = $id;

    $pdo->beginTransaction();
    try {
        $pdo->prepare("UPDATE $table SET " . implode(',', $sets) . " WHERE $pk = ?")->execute($params);
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields, change_reason) VALUES (?, ?, 'UPDATE', ?, ?, ?)")
            ->execute([$table, $id, $observer['observer_id'], json_encode($changed), $reason]);
        $pdo->commit();
        echo json_encode(['success'=>true, 'changed'=>count($changed)]);
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(400); echo json_encode(['error'=>$e->getMessage()]); }
}

function handleDelete($pdo, $table, $pk, $id, $observer) {
    if (!$id) { http_response_code(400); echo json_encode(['error'=>'id required']); return; }
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $stmt = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?"); $stmt->execute([$id]);
    $old = $stmt->fetch();
    if (!$old) { http_response_code(404); echo json_encode(['error'=>'Not found']); return; }

    $pdo->beginTransaction();
    try {
        if ($table === 'observations') {
            // Soft delete observation and its related scans/biometrics
            $oid = $observer['observer_id'];
            $pdo->prepare("UPDATE observations SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")->execute([$oid, $id]);
            $pdo->prepare("UPDATE penguin_scans SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")->execute([$oid, $id]);
            $pdo->prepare("UPDATE penguin_biometric_data SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE observation_id = ?")->execute([$oid, $id]);
        } elseif ($table === 'penguin_scans' || $table === 'penguin_biometric_data') {
            // Soft delete
            $pdo->prepare("UPDATE $table SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE $pk = ?")->execute([$observer['observer_id'], $id]);
        } else {
            $pdo->prepare("DELETE FROM $table WHERE $pk = ?")->execute([$id]);
        }
        $reason = $body['_reason'] ?? null;
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields, change_reason) VALUES (?, ?, 'DELETE', ?, ?, ?)")
            ->execute([$table, $id, $observer['observer_id'], json_encode($old), $reason]);
        $pdo->commit();
        echo json_encode(['success'=>true]);
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(400); echo json_encode(['error'=>$e->getMessage()]); }
}

function handleHistory($pdo, $table, $id) {
    if (!$table || !$id) { echo json_encode(['error'=>'table and id required']); return; }

    if ($table === 'observations') {
        // Get scan IDs belonging to this observation (current + from audit log)
        $scanStmt = $pdo->prepare("SELECT scan_id FROM penguin_scans WHERE observation_id = ?");
        $scanStmt->execute([$id]);
        $scanIds = $scanStmt->fetchAll(PDO::FETCH_COLUMN);

        // Also find scans referenced in audit log for this observation
        $auditStmt = $pdo->prepare("SELECT record_id FROM audit_log WHERE table_name = 'penguin_scans' AND changed_fields LIKE ?");
        $auditStmt->execute(['%"observation_id":' . (int)$id . '%']);
        foreach ($auditStmt->fetchAll(PDO::FETCH_COLUMN) as $sid) $scanIds[] = $sid;
        // Also match string-encoded observation_id
        $auditStmt2 = $pdo->prepare("SELECT record_id FROM audit_log WHERE table_name = 'penguin_scans' AND changed_fields LIKE ?");
        $auditStmt2->execute(['%"observation_id":"' . (int)$id . '"%']);
        foreach ($auditStmt2->fetchAll(PDO::FETCH_COLUMN) as $sid) $scanIds[] = $sid;
        $scanIds = array_unique($scanIds);

        if (!empty($scanIds)) {
            $placeholders = implode(',', array_fill(0, count($scanIds), '?'));
            $stmt = $pdo->prepare("SELECT a.*, o.observer_name FROM audit_log a JOIN observers o ON a.observer_id = o.observer_id
                WHERE (a.table_name = ? AND a.record_id = ?)
                   OR (a.table_name = 'penguin_scans' AND a.record_id IN ($placeholders))
                ORDER BY a.change_timestamp DESC LIMIT 100");
            $stmt->execute(array_merge([$table, $id], $scanIds));
        } else {
            $stmt = $pdo->prepare("SELECT a.*, o.observer_name FROM audit_log a JOIN observers o ON a.observer_id = o.observer_id WHERE a.table_name = ? AND a.record_id = ? ORDER BY a.change_timestamp DESC LIMIT 50");
            $stmt->execute([$table, $id]);
        }

        // Enrich scan entries with penguin info
        $results = $stmt->fetchAll();
        foreach ($results as &$entry) {
            if ($entry['table_name'] === 'penguin_scans') {
                $fields = json_decode($entry['changed_fields'], true);
                $pitId = $fields['pit_id'] ?? $fields['peng_num'] ?? null;
                if ($pitId) {
                    $pStmt = $pdo->prepare("SELECT p.peng_num, pc.pit_id, p.sex FROM penguin_chips pc JOIN penguins p ON pc.peng_num = p.peng_num WHERE pc.pit_id = ? OR p.peng_num = ?");
                    $pStmt->execute([$pitId, $pitId]);
                    $penguin = $pStmt->fetch();
                    if ($penguin) $entry['penguin_info'] = $penguin;
                }
            }
        }
        echo json_encode($results);
    } else {
        $stmt = $pdo->prepare("SELECT a.*, o.observer_name FROM audit_log a JOIN observers o ON a.observer_id = o.observer_id WHERE a.table_name = ? AND a.record_id = ? ORDER BY a.change_timestamp DESC LIMIT 50");
        $stmt->execute([$table, $id]);
        echo json_encode($stmt->fetchAll());
    }
}

function handleChangePassword($pdo, $observer) {
    $input = json_decode(file_get_contents('php://input'), true);
    $current = $input['current_password'] ?? '';
    $newPass = $input['new_password'] ?? '';

    if (!password_verify($current, $observer['passphrase_hash'])) {
        http_response_code(401); echo json_encode(['error'=>'Current password incorrect']); return;
    }
    if (strlen($newPass) < 6) {
        http_response_code(400); echo json_encode(['error'=>'New password must be 6+ characters']); return;
    }

    $hash = password_hash($newPass, PASSWORD_BCRYPT);
    $pdo->prepare("UPDATE observers SET passphrase_hash = ? WHERE observer_id = ?")
        ->execute([$hash, $observer['observer_id']]);

    echo json_encode(['success'=>true]);
}
