<?php
/**
 * Cleanup migration: biometrics, audit_log, observation_locations.
 *
 * curl -H 'X-API-Key: tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf' https://wildwatch.co.nz/penguin-api/migrate_cleanup.php
 */
require_once 'config.php';
setHeaders();
requireAuth();
$pdo = getDbConnection();

echo "=== CLEANUP MIGRATION ===\n\n";

// 1. audit_log: record_id INT -> VARCHAR(50)
echo "--- audit_log ---\n";
$pdo->exec("ALTER TABLE audit_log MODIFY record_id VARCHAR(50) NOT NULL");
echo "record_id -> VARCHAR(50)\n";

// 2. observation_locations: rfid_* -> pit_*
echo "\n--- observation_locations ---\n";
$renames = [
    'rfid_tag_number' => 'pit_id VARCHAR(50)',
    'rfid_scan_time_utc' => 'pit_scan_time_utc DATETIME',
    'rfid_latitude' => 'pit_latitude DOUBLE',
    'rfid_longitude' => 'pit_longitude DOUBLE',
    'rfid_accuracy' => 'pit_accuracy FLOAT',
];
foreach ($renames as $old => $new) {
    try { $pdo->exec("ALTER TABLE observation_locations CHANGE $old $new"); echo "Renamed $old\n"; }
    catch (Exception $e) { echo "$old: {$e->getMessage()}\n"; }
}

// 3. penguin_biometric_data: cleanup
echo "\n--- penguin_biometric_data ---\n";
$drops = ['left_flipper_length', 'body_length', 'beak_length', 'condition_healthy', 'sex'];
foreach ($drops as $col) {
    try { $pdo->exec("ALTER TABLE penguin_biometric_data DROP COLUMN $col"); echo "Dropped $col\n"; }
    catch (Exception $e) { echo "$col: {$e->getMessage()}\n"; }
}

// Add new disposition columns
try { $pdo->exec("ALTER TABLE penguin_biometric_data ADD COLUMN disposition_aggressive BOOLEAN DEFAULT FALSE"); echo "Added disposition_aggressive\n"; } catch (Exception $e) { echo "disposition_aggressive: {$e->getMessage()}\n"; }
try { $pdo->exec("ALTER TABLE penguin_biometric_data ADD COLUMN disposition_passive BOOLEAN DEFAULT FALSE"); echo "Added disposition_passive\n"; } catch (Exception $e) { echo "disposition_passive: {$e->getMessage()}\n"; }

// 4. Verify
echo "\n=== VERIFY ===\n";
$tables = ['audit_log', 'observation_locations', 'penguin_biometric_data'];
foreach ($tables as $t) {
    $cols = $pdo->query("SHOW COLUMNS FROM $t")->fetchAll(PDO::FETCH_COLUMN);
    echo "$t: " . implode(', ', $cols) . "\n";
}
echo "\nDone!\n";
