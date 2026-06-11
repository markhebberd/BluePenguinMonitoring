<?php
/**
 * Migration: Standardise chip identifier to pit_id, drop redundant columns.
 *
 * curl -H 'X-API-Key: tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf' https://wildwatch.co.nz/penguin-api/migrate_pit_id.php
 */
require_once 'config.php';
setHeaders();
requireAuth();
$pdo = getDbConnection();

echo "=== MIGRATE TO pit_id ===\n\n";
$pdo->exec("SET FOREIGN_KEY_CHECKS = 0");

// 1. penguin_chips: rename chip_number→pit_id, drop chip_id/full_iso/chip_ok, make pit_id PK
echo "--- penguin_chips ---\n";

// Drop existing FKs on penguin_chips
$fks = $pdo->query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_NAME = 'penguin_chips' AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND TABLE_SCHEMA = DATABASE()")->fetchAll(PDO::FETCH_COLUMN);
foreach ($fks as $fk) { $pdo->exec("ALTER TABLE penguin_chips DROP FOREIGN KEY $fk"); echo "Dropped FK $fk\n"; }

// Drop FKs referencing penguin_chips
$fks2 = $pdo->query("SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME = 'penguin_chips' AND TABLE_SCHEMA = DATABASE()")->fetchAll();
foreach ($fks2 as $fk) { try { $pdo->exec("ALTER TABLE {$fk['TABLE_NAME']} DROP FOREIGN KEY {$fk['CONSTRAINT_NAME']}"); echo "Dropped FK {$fk['CONSTRAINT_NAME']} on {$fk['TABLE_NAME']}\n"; } catch (Exception $e) {} }

$pdo->exec("ALTER TABLE penguin_chips CHANGE chip_number pit_id VARCHAR(17) NOT NULL");
echo "Renamed chip_number -> pit_id\n";

try { $pdo->exec("ALTER TABLE penguin_chips DROP COLUMN full_iso"); echo "Dropped full_iso\n"; } catch (Exception $e) { echo "full_iso: {$e->getMessage()}\n"; }
try { $pdo->exec("ALTER TABLE penguin_chips DROP COLUMN chip_ok"); echo "Dropped chip_ok\n"; } catch (Exception $e) { echo "chip_ok: {$e->getMessage()}\n"; }

// Change PK from chip_id to pit_id
try { $pdo->exec("ALTER TABLE penguin_chips DROP PRIMARY KEY"); } catch (Exception $e) {}
try { $pdo->exec("ALTER TABLE penguin_chips DROP COLUMN chip_id"); echo "Dropped chip_id\n"; } catch (Exception $e) { echo "chip_id: {$e->getMessage()}\n"; }
$pdo->exec("ALTER TABLE penguin_chips ADD PRIMARY KEY (pit_id)");
echo "pit_id is now PK\n";

// Re-add FK to penguins
$pdo->exec("ALTER TABLE penguin_chips ADD CONSTRAINT fk_chips_peng FOREIGN KEY (peng_num) REFERENCES penguins(peng_num)");
echo "Re-added FK to penguins\n";

// 2. penguin_scans: drop old cols, add pit_id
echo "\n--- penguin_scans ---\n";

// Drop FKs on penguin_scans
$fks3 = $pdo->query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_NAME = 'penguin_scans' AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND TABLE_SCHEMA = DATABASE()")->fetchAll(PDO::FETCH_COLUMN);
foreach ($fks3 as $fk) { $pdo->exec("ALTER TABLE penguin_scans DROP FOREIGN KEY $fk"); echo "Dropped FK $fk\n"; }

$dropCols = ['chip_id', 'peng_num', 'latitude', 'longitude', 'accuracy', 'created_at'];
foreach ($dropCols as $col) {
    try { $pdo->exec("ALTER TABLE penguin_scans DROP COLUMN $col"); echo "Dropped $col\n"; } catch (Exception $e) { echo "$col: {$e->getMessage()}\n"; }
}

try { $pdo->exec("ALTER TABLE penguin_scans ADD COLUMN pit_id VARCHAR(17) AFTER observation_id"); echo "Added pit_id\n"; } catch (Exception $e) { echo "pit_id: {$e->getMessage()}\n"; }

$pdo->exec("ALTER TABLE penguin_scans ADD CONSTRAINT fk_scans_chip FOREIGN KEY (pit_id) REFERENCES penguin_chips(pit_id)");
echo "Added FK pit_id -> penguin_chips\n";

// Re-add observation FK
try { $pdo->exec("ALTER TABLE penguin_scans ADD CONSTRAINT fk_scans_obs FOREIGN KEY (observation_id) REFERENCES observations(observation_id) ON DELETE CASCADE"); } catch (Exception $e) {}

// 3. penguins: drop tag_number, chip_date, initial_chip_date
echo "\n--- penguins ---\n";
$dropPeng = ['tag_number', 'chip_date', 'initial_chip_date'];
foreach ($dropPeng as $col) {
    try { $pdo->exec("ALTER TABLE penguins DROP COLUMN $col"); echo "Dropped $col\n"; } catch (Exception $e) { echo "$col: {$e->getMessage()}\n"; }
}

$pdo->exec("SET FOREIGN_KEY_CHECKS = 1");

// Verify
echo "\n=== VERIFY ===\n";
$tables = ['penguins', 'penguin_chips', 'penguin_scans'];
foreach ($tables as $t) {
    $cols = $pdo->query("SHOW COLUMNS FROM $t")->fetchAll(PDO::FETCH_COLUMN);
    echo "$t: " . implode(', ', $cols) . "\n";
}

echo "\nSample penguin: " . json_encode($pdo->query("SELECT * FROM penguins LIMIT 1")->fetch()) . "\n";
echo "Sample chip: " . json_encode($pdo->query("SELECT * FROM penguin_chips LIMIT 1")->fetch()) . "\n";
echo "\nDone!\n";
