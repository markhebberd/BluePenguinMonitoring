<?php
/**
 * Migration: Replace penguin_id with peng_num as primary key.
 * peng_num becomes the FK in penguin_chips, penguin_scans, penguin_biometric_data.
 *
 * curl -H 'X-API-Key: tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf' https://wildwatch.co.nz/penguin-api/migrate_peng_num_pk.php
 */
require_once 'config.php';
setHeaders();
validateApiKey();
$pdo = getDbConnection();

echo "=== MIGRATE penguin_id -> peng_num ===\n\n";

$pdo->exec("SET FOREIGN_KEY_CHECKS = 0");

// 1. Add peng_num column to child tables
echo "Adding peng_num to penguin_chips...\n";
try { $pdo->exec("ALTER TABLE penguin_chips ADD COLUMN peng_num VARCHAR(20) AFTER penguin_id"); } catch (Exception $e) { echo "  (already exists)\n"; }

echo "Adding peng_num to penguin_scans...\n";
try { $pdo->exec("ALTER TABLE penguin_scans ADD COLUMN peng_num VARCHAR(20) AFTER penguin_id"); } catch (Exception $e) { echo "  (already exists)\n"; }

echo "Adding peng_num to penguin_biometric_data...\n";
try { $pdo->exec("ALTER TABLE penguin_biometric_data ADD COLUMN peng_num VARCHAR(20) AFTER penguin_id"); } catch (Exception $e) { echo "  (already exists)\n"; }

// 2. Populate peng_num in child tables from penguins
echo "Populating peng_num in penguin_chips...\n";
$pdo->exec("UPDATE penguin_chips pc JOIN penguins p ON pc.penguin_id = p.penguin_id SET pc.peng_num = p.peng_num");

echo "Populating peng_num in penguin_scans...\n";
$pdo->exec("UPDATE penguin_scans ps JOIN penguins p ON ps.penguin_id = p.penguin_id SET ps.peng_num = p.peng_num");

echo "Populating peng_num in penguin_biometric_data...\n";
$pdo->exec("UPDATE penguin_biometric_data bd JOIN penguins p ON bd.penguin_id = p.penguin_id SET bd.peng_num = p.peng_num");

// 3. Drop old FK constraints and penguin_id columns from child tables
echo "Dropping old FKs and penguin_id columns...\n";

// Get FK constraint names
$fks = $pdo->query("SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME = 'penguins' AND TABLE_SCHEMA = DATABASE()")->fetchAll();
foreach ($fks as $fk) {
    echo "  Dropping FK {$fk['CONSTRAINT_NAME']} on {$fk['TABLE_NAME']}\n";
    $pdo->exec("ALTER TABLE {$fk['TABLE_NAME']} DROP FOREIGN KEY {$fk['CONSTRAINT_NAME']}");
}

$pdo->exec("ALTER TABLE penguin_chips DROP COLUMN penguin_id");
$pdo->exec("ALTER TABLE penguin_scans DROP COLUMN penguin_id");
$pdo->exec("ALTER TABLE penguin_biometric_data DROP COLUMN penguin_id");
echo "  Dropped penguin_id from child tables\n";

// 4. Change penguins PK
echo "Changing penguins PK to peng_num...\n";
$pdo->exec("ALTER TABLE penguins DROP PRIMARY KEY");
$pdo->exec("ALTER TABLE penguins DROP COLUMN penguin_id");
$pdo->exec("ALTER TABLE penguins ADD PRIMARY KEY (peng_num)");

// 5. Add FK constraints using peng_num
echo "Adding new FKs...\n";
$pdo->exec("ALTER TABLE penguin_chips ADD CONSTRAINT fk_chips_peng FOREIGN KEY (peng_num) REFERENCES penguins(peng_num)");
$pdo->exec("ALTER TABLE penguin_scans ADD CONSTRAINT fk_scans_peng FOREIGN KEY (peng_num) REFERENCES penguins(peng_num)");
$pdo->exec("ALTER TABLE penguin_biometric_data ADD CONSTRAINT fk_bio_peng FOREIGN KEY (peng_num) REFERENCES penguins(peng_num)");

$pdo->exec("SET FOREIGN_KEY_CHECKS = 1");

// 6. Verify
echo "\n=== VERIFY ===\n";
$cols = $pdo->query("SHOW COLUMNS FROM penguins")->fetchAll(PDO::FETCH_COLUMN);
echo "penguins: " . implode(', ', $cols) . "\n";
$cols = $pdo->query("SHOW COLUMNS FROM penguin_chips")->fetchAll(PDO::FETCH_COLUMN);
echo "penguin_chips: " . implode(', ', $cols) . "\n";
$cols = $pdo->query("SHOW COLUMNS FROM penguin_scans")->fetchAll(PDO::FETCH_COLUMN);
echo "penguin_scans: " . implode(', ', $cols) . "\n";

$sample = $pdo->query("SELECT * FROM penguin_chips LIMIT 2")->fetchAll();
echo "\nSample chips:\n";
foreach ($sample as $s) echo "  " . json_encode($s) . "\n";

echo "\nDone!\n";
