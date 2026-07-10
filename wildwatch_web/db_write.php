<?php
/**
 * The single gateway between the clients (NestCheck app, Wildwatch web) and the data tables.
 *
 * Every INSERT / UPDATE / DELETE against a biological data table goes through one of the four
 * functions below, and each writes its own audit_log row. Auditing is therefore not something a
 * caller can forget: there is no other way to write. Endpoints (crud.php, sync.php, admin.php,
 * boxtags.php, integrity.php) are left with validation, permissions and routing.
 *
 * Deliberately NOT covered: sessions, password_resets, disk_history. Those are infrastructure,
 * not observations — auditing every login would bury the biological trail in noise.
 *
 * Callers must own the transaction. These functions never begin/commit, so a multi-row operation
 * (a sync, an import, a cascade delete) stays atomic and rolls back as a unit.
 */

/** Primary key of every writable data table. A table absent from this map cannot be written.
 *  date_mappings is deliberately absent: its key is composite (season_year, date_number) and a
 *  season is rewritten wholesale, so crud.php audits that replacement as one old => new diff. */
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
    'observers'             => 'observer_id',
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
    $pdo->prepare($sql)->execute(array_values($row));
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
    $pdo->prepare($sql)->execute(array_values($row));
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
        ->execute(array_merge(array_map(fn($c) => $fields[$c], array_keys($changed)), [$id]));
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
