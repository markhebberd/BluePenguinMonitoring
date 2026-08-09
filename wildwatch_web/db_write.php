<?php
/**
 * The single gateway between the clients (NestCheck app, Wildwatch web) and the data tables.
 *
 * Every INSERT / UPDATE / DELETE against a biological data table goes through one of the four
 * functions below, and each writes its own audit_log row. Auditing is therefore not something a
 * caller can forget: there is no other way to write. Endpoints (crud.php, sync.php, admin.php,
 * boxtags.php, integrity.php) are left with validation, permissions and routing.
 *
 * Infrastructure tables (sessions, password_resets, disk_history) are written by the unaudited
 * helpers at the bottom of this file — auditing every login would bury the biological trail in
 * noise, but their SQL lives here too so this file is the database's only writer.
 *
 * Callers must own the transaction. These functions never begin/commit, so a multi-row operation
 * (a sync, an import, a cascade delete) stays atomic and rolls back as a unit.
 */

/** Primary key of every writable data table. A table absent from this map cannot be written.
 *  date_mappings is deliberately absent from the row-oriented functions: its key is composite
 *  (season_year, date_number) and a season is rewritten wholesale — use wwAuditedReplaceSeason. */
const WW_TABLE_KEYS = [
    'observations'          => 'observation_id',
    'penguin_scans'         => 'scan_id',
    'penguin_biometric_data'=> 'biometric_id',
    'penguins'              => 'peng_num',
    'penguin_chips'         => 'pit_id',
    'observation_locations' => 'location_id',
    'regions'               => 'region_id',
    'colonies'              => 'colony_id',
    'colony_permissions'    => 'permission_id',
    'validation_dismissals' => 'id',
    'users'                 => 'id',
    'breeding_verifications'                => 'verification_id',
    'day_notes'             => 'day_note_id',
];

/** Tables whose primary key is a natural string, not an auto-increment id. For these
 *  lastInsertId() returns 0, so the audit entry must take its record_id from the row. */
const WW_NATURAL_KEYS = ['penguins' => 'peng_num', 'penguin_chips' => 'pit_id'];

/** Tables that carry is_deleted/deleted_at/deleted_by — deletion here means soft deletion. */
const WW_SOFT_DELETE_TABLES = ['observations', 'penguin_scans', 'penguin_biometric_data'];

function wwTableKey(string $table): string {
    if (!isset(WW_TABLE_KEYS[$table])) {
        throw new InvalidArgumentException("Table '$table' is not writable through the data gateway");
    }
    return WW_TABLE_KEYS[$table];
}

/** PDO binds a PHP bool `false` as '' (and `true` as '1'), which a tinyint/int column rejects
 *  with "Incorrect integer value: ''". JSON flags such as is_moulting arrive as booleans, so
 *  coerce every bool to 0/1 before binding — otherwise a whole row (e.g. a biometric with a sex
 *  guess but is_moulting=false) fails to write and re-fails on every sync. */
function wwBindVals(array $vals): array {
    return array_map(fn($v) => is_bool($v) ? (int)$v : $v, $vals);
}

/** Columns whose value must never reach the audit log — secrets, not data. */
const WW_REDACTED_COLUMNS = ['passphrase_hash', 'token_hash', 'token'];

/** Replace secret values with a marker, preserving the old => new shape so the log still
 *  records THAT a password changed, never what it changed to. */
function wwRedact(array $fields): array {
    foreach ($fields as $col => $val) {
        if (!in_array($col, WW_REDACTED_COLUMNS, true)) continue;
        $fields[$col] = (is_array($val) && (array_key_exists('old', $val) || array_key_exists('new', $val)))
            ? ['old' => '(redacted)', 'new' => '(redacted)']
            : '(redacted)';
    }
    return $fields;
}

function wwAudit($pdo, string $table, $recordId, string $action, $fields, $observerId, $reason = null): void {
    if (is_array($fields)) $fields = wwRedact($fields);
    $pdo->prepare("INSERT INTO audit_log (table_name, record_id, action, observer_id, changed_fields, change_reason) VALUES (?, ?, ?, ?, ?, ?)")
        ->execute([$table, (string)$recordId, $action, $observerId, json_encode($fields), $reason]);
}

/** INSERT one row. Returns the new key (auto-increment id, or the natural key). */
function wwAuditedInsert($pdo, $table, $row, $observerId, $reason = null) {
    wwTableKey($table);
    $cols = array_keys($row);
    $sql = "INSERT INTO $table (" . implode(',', $cols) . ") VALUES (" . implode(',', array_fill(0, count($cols), '?')) . ")";
    $pdo->prepare($sql)->execute(wwBindVals(array_values($row)));
    $keyCol = WW_NATURAL_KEYS[$table] ?? null;
    $recordId = ($keyCol !== null && isset($row[$keyCol])) ? $row[$keyCol] : $pdo->lastInsertId();
    wwAudit($pdo, $table, $recordId, 'INSERT', $row, $observerId, $reason);
    return $recordId;
}

/**
 * INSERT a row whose own new id is the acting observer — self-signup, where nobody else has
 * authenticated yet. audit_log.observer_id is NOT NULL with an FK, so the actor cannot be null
 * and cannot be known before the insert.
 */
function wwAuditedInsertSelf($pdo, $table, $row, $reason = null) {
    wwTableKey($table);
    $cols = array_keys($row);
    $sql = "INSERT INTO $table (" . implode(',', $cols) . ") VALUES (" . implode(',', array_fill(0, count($cols), '?')) . ")";
    $pdo->prepare($sql)->execute(wwBindVals(array_values($row)));
    $newId = $pdo->lastInsertId();
    wwAudit($pdo, $table, $newId, 'INSERT', $row, $newId, $reason);
    return $newId;
}

/**
 * UPDATE one row, auditing only the columns whose value actually changed, as old => new.
 * Returns the number of changed columns; 0 means nothing was written and nothing audited.
 */
function wwAuditedUpdate($pdo, $table, $id, $fields, $observerId, $reason = null): int {
    $pk = wwTableKey($table);
    $sel = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?");
    $sel->execute([$id]);
    $old = $sel->fetch(PDO::FETCH_ASSOC);
    if (!$old) throw new RuntimeException("$table $pk=$id not found");

    $changed = [];
    foreach ($fields as $col => $new) {
        if (($old[$col] ?? null) != $new) $changed[$col] = ['old' => $old[$col] ?? null, 'new' => $new];
    }
    if (!$changed) return 0;

    $sets = implode(',', array_map(fn($c) => "$c = ?", array_keys($changed)));
    $pdo->prepare("UPDATE $table SET $sets WHERE $pk = ?")
        ->execute(array_merge(wwBindVals(array_map(fn($c) => $fields[$c], array_keys($changed))), [$id]));
    wwAudit($pdo, $table, $id, 'UPDATE', $changed, $observerId, $reason);
    return count($changed);
}

/**
 * Delete one row — soft where the table supports it, hard otherwise. The audit entry carries the
 * whole row as it was, so even a hard delete leaves the data recoverable from the log.
 */
function wwAuditedDelete($pdo, $table, $id, $observerId, $reason = null, bool $hard = false): bool {
    $pk = wwTableKey($table);
    $sel = $pdo->prepare("SELECT * FROM $table WHERE $pk = ?");
    $sel->execute([$id]);
    $old = $sel->fetch(PDO::FETCH_ASSOC);
    if (!$old) return false;

    if (!$hard && in_array($table, WW_SOFT_DELETE_TABLES, true)) {
        $pdo->prepare("UPDATE $table SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ? WHERE $pk = ?")
            ->execute([$observerId, $id]);
    } else {
        $pdo->prepare("DELETE FROM $table WHERE $pk = ?")->execute([$id]);
    }
    wwAudit($pdo, $table, $id, 'DELETE', $old, $observerId, $reason);
    return true;
}

/**
 * Soft-delete every child row of an observation (its scans and biometrics), auditing each one.
 * The cascades used to run as bare UPDATEs, so an observation's history could not say which
 * birds were removed with it.
 */
function wwAuditedDeleteObservationChildren($pdo, $observationId, $observerId, $reason = null): array {
    $counts = [];
    foreach (['penguin_scans' => 'scan_id', 'penguin_biometric_data' => 'biometric_id'] as $table => $pk) {
        $sel = $pdo->prepare("SELECT $pk FROM $table WHERE observation_id = ? AND (is_deleted = FALSE OR is_deleted IS NULL)");
        $sel->execute([$observationId]);
        $ids = $sel->fetchAll(PDO::FETCH_COLUMN);
        foreach ($ids as $childId) wwAuditedDelete($pdo, $table, $childId, $observerId, $reason);
        $counts[$table] = count($ids);
    }
    return $counts;
}

/**
 * Replace a season's date_mappings wholesale. The one row-set-shaped write: the table's key is
 * composite (season_year, date_number) and the UI edits a season as a unit, so it is audited as
 * a single old => new diff under record_id = season_year. Caller owns the transaction.
 */
function wwAuditedReplaceSeason($pdo, int $season, array $rows, $observerId, $reason = null): int {
    $old = $pdo->prepare("SELECT date_number, actual_date, partial_monitor FROM date_mappings WHERE season_year = ? ORDER BY date_number");
    $old->execute([$season]);
    $oldMappings = $old->fetchAll(PDO::FETCH_ASSOC);

    $pdo->prepare("DELETE FROM date_mappings WHERE season_year = ?")->execute([$season]);
    $ins = $pdo->prepare("INSERT INTO date_mappings (season_year, date_number, actual_date, partial_monitor) VALUES (?, ?, ?, ?)");
    foreach ($rows as $row) {
        $ins->execute([$season, $row['n'], $row['date'], !empty($row['partial']) ? 1 : 0]);
    }
    wwAudit($pdo, 'date_mappings', $season, 'UPDATE', ['season' => $season, 'old' => $oldMappings, 'new' => $rows], $observerId, $reason);
    return count($rows);
}

/**
 * Renumber a penguin: peng_num $from -> $to, carrying its chips and biometrics with it.
 *
 * One UPDATE on the parent — the child FKs (penguin_chips, penguin_biometric_data) are
 * ON UPDATE CASCADE, so their peng_num follows automatically. The bird's audit history is then
 * repointed to the new number: audit_log.record_id is polymorphic (no FK), so the cascade can't
 * reach it, and without the repoint a renamed bird's history would split across two numbers.
 * changed_fields JSON in old entries keeps whatever number was current when each was written —
 * the log's content is a snapshot; only the lookup key follows the bird.
 * $to must be vacant. Returns [chips, biometrics] carried, for reporting.
 */
/** Rewrite peng_nums inside breeding_verifications.chicks (a JSON array, no FK, so renumbers must
 *  reach it explicitly). $map is old=>new applied SIMULTANEOUSLY, so a swap (a=>b, b=>a) is correct.
 *  Renumbers touch few rows; each rewrite is audited. male/female cascade via their FKs, not here. */
function wwRewriteVerificationChicks($pdo, array $map, $observerId, $reason = null): void {
    foreach ($pdo->query("SELECT verification_id, chicks FROM breeding_verifications WHERE chicks IS NOT NULL")->fetchAll() as $r) {
        $arr = json_decode($r['chicks'], true);
        if (!is_array($arr)) continue;
        $changed = false;
        $new = array_map(function ($pn) use ($map, &$changed) {
            if (array_key_exists($pn, $map)) { $changed = true; return $map[$pn]; }
            return $pn;
        }, $arr);
        if ($changed) wwAuditedUpdate($pdo, 'breeding_verifications', $r['verification_id'], ['chicks' => json_encode($new)], $observerId, $reason);
    }
}

function wwAuditedRenumberPenguin($pdo, $from, $to, $observerId, $reason = null): array {
    $sel = $pdo->prepare("SELECT 1 FROM penguins WHERE peng_num = ?");
    $sel->execute([$from]);
    if (!$sel->fetchColumn()) throw new RuntimeException("penguin $from not found");

    $clash = $pdo->prepare("SELECT 1 FROM penguins WHERE peng_num = ?");
    $clash->execute([$to]);
    if ($clash->fetchColumn()) throw new RuntimeException("target peng_num $to is not vacant");

    $count = $pdo->prepare("SELECT
        (SELECT COUNT(*) FROM penguin_chips WHERE peng_num = ?) AS chips,
        (SELECT COUNT(*) FROM penguin_biometric_data WHERE peng_num = ?) AS biometrics");
    $count->execute([$from, $from]);
    ['chips' => $chips, 'biometrics' => $bios] = array_map('intval', $count->fetch(PDO::FETCH_ASSOC));

    $pdo->prepare("UPDATE penguins SET peng_num = ? WHERE peng_num = ?")->execute([$to, $from]);
    $pdo->prepare("UPDATE audit_log SET record_id = ? WHERE table_name = 'penguins' AND record_id = ?")
        ->execute([$to, $from]);
    // male/female verification FKs cascaded; the chicks JSON has no FK, so rewrite it here.
    wwRewriteVerificationChicks($pdo, [$from => $to], $observerId, $reason);
    wwAudit($pdo, 'penguins', $to, 'UPDATE',
        ['peng_num' => ['old' => $from, 'new' => $to], 'chips_carried' => $chips, 'biometrics_carried' => $bios],
        $observerId, $reason);
    return ['chips' => $chips, 'biometrics' => $bios];
}

/**
 * Swap two penguins' numbers. Three cascading renames through a temporary number (both slots are
 * occupied, so neither direct rename is possible), but audited as what it is: one UPDATE entry per
 * bird, each showing its own old => new number. Audit histories are swapped along with the
 * numbers, so each bird's log entries stay findable under its current number.
 * Returns per-bird carried counts keyed by final number.
 */
function wwAuditedSwapPenguins($pdo, $a, $b, $observerId, $reason = null): array {
    if ($a === $b) throw new RuntimeException("cannot swap $a with itself");
    foreach ([$a, $b] as $pn) {
        $sel = $pdo->prepare("SELECT 1 FROM penguins WHERE peng_num = ?");
        $sel->execute([$pn]);
        if (!$sel->fetchColumn()) throw new RuntimeException("penguin $pn not found");
    }

    $tmp = '~swap~';   // fits varchar(20); '~' is outside the colony-prefix alphabet, so always vacant
    $clash = $pdo->prepare("SELECT 1 FROM penguins WHERE peng_num = ?");
    $clash->execute([$tmp]);
    if ($clash->fetchColumn()) throw new RuntimeException("temporary number $tmp is occupied — previous swap left debris?");

    $counts = [];
    $count = $pdo->prepare("SELECT
        (SELECT COUNT(*) FROM penguin_chips WHERE peng_num = ?) AS chips,
        (SELECT COUNT(*) FROM penguin_biometric_data WHERE peng_num = ?) AS biometrics");
    foreach (['a' => $a, 'b' => $b] as $k => $pn) {
        $count->execute([$pn, $pn]);
        $counts[$k] = array_map('intval', $count->fetch(PDO::FETCH_ASSOC));
    }

    $move = $pdo->prepare("UPDATE penguins SET peng_num = ? WHERE peng_num = ?");
    $repoint = $pdo->prepare("UPDATE audit_log SET record_id = ? WHERE table_name = 'penguins' AND record_id = ?");
    foreach ([[$a, $tmp], [$b, $a], [$tmp, $b]] as [$src, $dst]) {
        $move->execute([$dst, $src]);
        $repoint->execute([$dst, $src]);
    }

    // Verification male/female cascaded through the temp dance; swap the chicks JSON in one map.
    wwRewriteVerificationChicks($pdo, [$a => $b, $b => $a], $observerId, $reason);
    wwAudit($pdo, 'penguins', $b, 'UPDATE', ['peng_num' => ['old' => $a, 'new' => $b], 'swapped_with' => $a] + $counts['a'], $observerId, $reason);
    wwAudit($pdo, 'penguins', $a, 'UPDATE', ['peng_num' => ['old' => $b, 'new' => $a], 'swapped_with' => $b] + $counts['b'], $observerId, $reason);
    return [$b => $counts['a'], $a => $counts['b']];
}

/**
 * Insert-or-update keyed on $keyCols. Audited as an INSERT or a field-level UPDATE depending on
 * which happened, so an upsert is as legible in the log as either primitive alone.
 */
function wwAuditedUpsert($pdo, $table, $keyCols, $row, $observerId, $reason = null) {
    $pk = wwTableKey($table);
    $where = implode(' AND ', array_map(fn($c) => "$c = ?", $keyCols));
    $sel = $pdo->prepare("SELECT $pk FROM $table WHERE $where");
    $sel->execute(array_map(fn($c) => $row[$c], $keyCols));
    $existingId = $sel->fetchColumn();

    if ($existingId === false) return wwAuditedInsert($pdo, $table, $row, $observerId, $reason);
    $update = array_diff_key($row, array_flip($keyCols));
    wwAuditedUpdate($pdo, $table, $existingId, $update, $observerId, $reason);
    return $existingId;
}

// ============ Infrastructure writes (deliberately unaudited) ============
// Sessions, password resets and disk metrics are plumbing, not observations. Each helper is
// named for its one intent and contains its one statement.

/** Create a 30-day session for an observer and return its token. */
function wwSessionCreate($pdo, int $observerId): string {
    $token = bin2hex(random_bytes(32));
    $expires = date('Y-m-d H:i:s', time() + 86400 * 30);
    $pdo->prepare("INSERT INTO sessions (token, observer_id, expires_at) VALUES (?, ?, ?)")
        ->execute([$token, $observerId, $expires]);
    return $token;
}

/** A short-lived session for the deploy's payload contract check, which has to call the API as a
 *  real user because permissions shape what comes back. Minutes, not days, and deleted by
 *  wwSessionDelete as soon as the check is done. */
function wwSessionCreateShortLived($pdo, int $observerId, int $minutes): string {
    $token = 'contract' . bin2hex(random_bytes(24));
    $pdo->prepare("INSERT INTO sessions (token, observer_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))")
        ->execute([$token, $observerId, $minutes]);
    return $token;
}

/** Drop one session by token. */
function wwSessionDelete($pdo, string $token): void {
    $pdo->prepare("DELETE FROM sessions WHERE token = ?")->execute([$token]);
}

/** Sliding session: extend a valid token to 30 days out, at most once per day. */
function wwSessionTouch($pdo, string $token): void {
    $pdo->prepare("UPDATE sessions SET expires_at = NOW() + INTERVAL 30 DAY WHERE token = ? AND expires_at < NOW() + INTERVAL 29 DAY")
        ->execute([$token]);
}

/** Log an observer out everywhere — used after a password change. */
function wwSessionsDeleteForObserver($pdo, int $observerId): void {
    $pdo->prepare("DELETE FROM sessions WHERE observer_id = ?")->execute([$observerId]);
}

/** Create a reset/invite token: stores only its hash, returns the raw token for the email link. */
function wwPasswordResetCreate($pdo, int $observerId, string $purpose, int $ttlSeconds): string {
    $token = bin2hex(random_bytes(32));
    $pdo->prepare("INSERT INTO password_resets (token_hash, observer_id, purpose, expires_at)
        VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))")
        ->execute([hash('sha256', $token), $observerId, $purpose, $ttlSeconds]);
    return $token;
}

/** Mark a reset token used. */
function wwPasswordResetConsume($pdo, string $tokenHash): void {
    $pdo->prepare("UPDATE password_resets SET used_at = NOW() WHERE token_hash = ?")->execute([$tokenHash]);
}

/** Drop an observer's outstanding unused tokens — all of them, or one purpose only. */
function wwPasswordResetsInvalidate($pdo, int $observerId, ?string $purpose = null): void {
    $sql = "DELETE FROM password_resets WHERE observer_id = ? AND used_at IS NULL";
    $args = [$observerId];
    if ($purpose !== null) { $sql .= " AND purpose = ?"; $args[] = $purpose; }
    $pdo->prepare($sql)->execute($args);
}

/** Record a disk-free sample and prune samples older than 400 days. */
function wwDiskHistoryRecord($pdo, int $freeMb): void {
    $pdo->prepare("INSERT INTO disk_history (recorded_at, disk_free_mb) VALUES (UTC_TIMESTAMP(), ?)")->execute([$freeMb]);
    $pdo->exec("DELETE FROM disk_history WHERE recorded_at < UTC_TIMESTAMP() - INTERVAL 400 DAY");
}
