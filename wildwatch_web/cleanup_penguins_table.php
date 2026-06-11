<?php
/**
 * Remove redundant columns from penguins table.
 * chip_box, chip_by, chip_ok, chip_as are on penguin_chips.
 * chick_size is unused (chick_size_sex covers it).
 *
 * curl -H 'X-API-Key: tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf' https://wildwatch.co.nz/penguin-api/cleanup_penguins_table.php
 */
require_once 'config.php';
setHeaders();
requireAuth();
$pdo = getDbConnection();

$drops = ['chip_as', 'chip_box', 'chip_by', 'chip_ok', 'chick_size'];

foreach ($drops as $col) {
    try {
        $pdo->exec("ALTER TABLE penguins DROP COLUMN $col");
        echo "Dropped: $col\n";
    } catch (Exception $e) {
        echo "Skip $col: " . $e->getMessage() . "\n";
    }
}

// Show remaining columns
$cols = $pdo->query("SHOW COLUMNS FROM penguins")->fetchAll(PDO::FETCH_COLUMN);
echo "\nRemaining columns: " . implode(', ', $cols) . "\n";
