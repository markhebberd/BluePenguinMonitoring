<?php
/**
 * Drop retired biometric condition columns: underweight, dog_attacked, attacked.
 * These are no longer recorded by any app and are removed from the API + UI.
 * Idempotent — safe to run more than once.
 *
 * curl -H 'X-API-Key: tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf' https://wildwatch.co.nz/penguin-api/migrate_drop_conditions.php
 */
require_once 'config.php';
setHeaders();
requireReadAuth(); // accepts X-API-Key on GET (requireAuth is session-only and 401s the key)
$pdo = getDbConnection();

echo "=== DROP BIOMETRIC CONDITION COLUMNS ===\n\n";

$drops = ['condition_underweight', 'condition_dog_attacked', 'condition_attacked'];
foreach ($drops as $col) {
    try { $pdo->exec("ALTER TABLE penguin_biometric_data DROP COLUMN $col"); echo "Dropped $col\n"; }
    catch (Exception $e) { echo "$col: {$e->getMessage()}\n"; }
}

echo "\n--- remaining columns ---\n";
foreach ($pdo->query("SHOW COLUMNS FROM penguin_biometric_data") as $row) {
    echo "  {$row['Field']}\n";
}

echo "\nDone!\n";
