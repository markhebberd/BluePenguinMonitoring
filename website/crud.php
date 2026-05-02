<?php
/**
 * Audited CRUD API with session-based observer auth.
 *
 * POST ?action=login     - {email, password} -> token
 * POST ?action=register  - {name, email, password} (restricted emails only)
 *
 * All other actions require Authorization: Bearer <token>
 * GET    ?action=list&table=X[&field=val]
 * GET    ?action=get&table=X&id=N
 * POST   ?action=create&table=X  (JSON body)
 * POST   ?action=update&table=X&id=N  (JSON body)
 * POST   ?action=delete&table=X&id=N
 */
require_once 'config.php';

header('Content-Type: application/json');
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

$observer = authenticate($pdo);
if (!$observer) { http_response_code(401); echo json_encode(['error' => 'Not authenticated']); exit; }

if ($action === 'change_password') { handleChangePassword($pdo, $observer); exit; }

$table = $_GET['table'] ?? '';
$id = $_GET['id'] ?? null;

$tables = [
    'observations' => 'observation_id',
    'penguins' => 'penguin_id',
    'penguin_scans' => 'scan_id',
    'penguin_biometric_data' => 'biometric_id',
];

if (!in_array($action, ['list','get','create','update','delete'])) { echo json_encode(['error'=>'Invalid action']); exit; }
if (!isset($tables[$table])) { echo json_encode(['error'=>'Invalid table']); exit; }

$pk = $tables[$table];

switch ($action) {
    case 'list': handleList($pdo, $table); break;
    case 'get': handleGet($pdo, $table, $pk, $id); break;
    case 'create': handleCreate($pdo, $table, $pk, $observer); break;
    case 'update': handleUpdate($pdo, $table, $pk, $id, $observer); break;
    case 'delete': handleDelete($pdo, $table, $pk, $id, $observer); break;
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

    echo json_encode(['token'=>$token, 'observer_id'=>$observer['observer_id'], 'name'=>$observer['observer_name'], 'expires'=>$expires]);
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
        $pdo->prepare("INSERT INTO observers (observer_name, email, passphrase_hash) VALUES (?, ?, ?)")
            ->execute([$name, $email, $hash]);
        echo json_encode(['success'=>true, 'observer_id'=>$pdo->lastInsertId()]);
    } catch (Exception $e) {
        http_response_code(409); echo json_encode(['error'=>'Name or email already exists']);
    }
}

function authenticate($pdo) {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $header, $m)) return null;
    $stmt = $pdo->prepare("SELECT o.* FROM sessions s JOIN observers o ON s.observer_id = o.observer_id WHERE s.token = ? AND s.expires_at > NOW()");
    $stmt->execute([$m[1]]);
    return $stmt->fetch() ?: null;
}

function handleList($pdo, $table) {
    $where = []; $params = [];
    foreach ($_GET as $k => $v) {
        if (in_array($k, ['action','table'])) continue;
        $where[] = "$k = ?"; $params[] = $v;
    }
    $sql = "SELECT * FROM $table";
    if ($where) $sql .= " WHERE " . implode(' AND ', $where);
    $sql .= " ORDER BY 1 DESC LIMIT 100";
    $stmt = $pdo->prepare($sql); $stmt->execute($params);
    echo json_encode($stmt->fetchAll());
}

function handleGet($pdo, $table, $pk, $id) {
    if (!$id) { echo json_encode(['error'=>'id required']); return; }
    $stmt = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?"); $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) { http_response_code(404); echo json_encode(['error'=>'Not found']); return; }
    echo json_encode($row);
}

function handleCreate($pdo, $table, $pk, $observer) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { http_response_code(400); echo json_encode(['error'=>'JSON body required']); return; }

    $cols = array_keys($input);
    $pdo->beginTransaction();
    try {
        $sql = "INSERT INTO $table (" . implode(',', $cols) . ") VALUES (" . implode(',', array_fill(0, count($cols), '?')) . ")";
        $pdo->prepare($sql)->execute(array_values($input));
        $newId = $pdo->lastInsertId();
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES (?, ?, 'INSERT', ?, ?)")
            ->execute([$table, $newId, $observer['observer_id'], json_encode($input)]);
        $pdo->commit();
        echo json_encode(['success'=>true, 'id'=>$newId]);
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(400); echo json_encode(['error'=>$e->getMessage()]); }
}

function handleUpdate($pdo, $table, $pk, $id, $observer) {
    if (!$id) { http_response_code(400); echo json_encode(['error'=>'id required']); return; }
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { http_response_code(400); echo json_encode(['error'=>'JSON body required']); return; }

    $stmt = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?"); $stmt->execute([$id]);
    $old = $stmt->fetch();
    if (!$old) { http_response_code(404); echo json_encode(['error'=>'Not found']); return; }

    $sets = []; $params = []; $changed = [];
    foreach ($input as $col => $newVal) {
        $sets[] = "$col = ?"; $params[] = $newVal;
        if (($old[$col] ?? null) != $newVal) $changed[$col] = ['old'=>$old[$col] ?? null, 'new'=>$newVal];
    }
    if (empty($changed)) { echo json_encode(['success'=>true, 'changed'=>0]); return; }
    $params[] = $id;

    $pdo->beginTransaction();
    try {
        $pdo->prepare("UPDATE $table SET " . implode(',', $sets) . " WHERE $pk = ?")->execute($params);
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES (?, ?, 'UPDATE', ?, ?)")
            ->execute([$table, $id, $observer['observer_id'], json_encode($changed)]);
        $pdo->commit();
        echo json_encode(['success'=>true, 'changed'=>count($changed)]);
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(400); echo json_encode(['error'=>$e->getMessage()]); }
}

function handleDelete($pdo, $table, $pk, $id, $observer) {
    if (!$id) { http_response_code(400); echo json_encode(['error'=>'id required']); return; }
    $stmt = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?"); $stmt->execute([$id]);
    $old = $stmt->fetch();
    if (!$old) { http_response_code(404); echo json_encode(['error'=>'Not found']); return; }

    $pdo->beginTransaction();
    try {
        $pdo->prepare("DELETE FROM $table WHERE $pk = ?")->execute([$id]);
        $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields) VALUES (?, ?, 'DELETE', ?, ?)")
            ->execute([$table, $id, $observer['observer_id'], json_encode($old)]);
        $pdo->commit();
        echo json_encode(['success'=>true]);
    } catch (Exception $e) { $pdo->rollBack(); http_response_code(400); echo json_encode(['error'=>$e->getMessage()]); }
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
