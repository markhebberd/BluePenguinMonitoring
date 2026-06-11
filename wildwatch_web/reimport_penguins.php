<?php
/**
 * Nuke penguins, penguin_chips, penguin_scans, penguin_biometric_data and reimport from scratch.
 *
 * curl -H 'X-API-Key: tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf' https://wildwatch.co.nz/penguin-api/reimport_penguins.php
 */
require_once 'config.php';
setHeaders();
requireAuth();
$pdo = getDbConnection();

echo "=== WIPE & REIMPORT ===\n\n";

// 1. Nuke everything
$pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
$pdo->exec("TRUNCATE TABLE penguin_scans");
$pdo->exec("TRUNCATE TABLE penguin_biometric_data");
$pdo->exec("TRUNCATE TABLE penguin_chips");
$pdo->exec("TRUNCATE TABLE penguins");
$pdo->exec("TRUNCATE TABLE audit_log");
$pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
echo "Truncated: penguin_scans, penguin_biometric_data, penguin_chips, penguins, audit_log\n\n";

// 2. Import penguins from Google Sheets
echo "=== IMPORTING PENGUINS ===\n";

$csvUrl = 'https://docs.google.com/spreadsheets/d/1A2j56iz0_VNHiWNJORAzGDqTbZsEd76j-YI_gQZsDEE/gviz/tq?tqx=out:csv&gid=406382921';
$csv = @file_get_contents($csvUrl);
if (!$csv) {
    $csv = @null; // NO STALE FALLBACK
}
if (!$csv) { echo "ERROR: No CSV source available\n"; exit; }

$rows = [];
$handle = fopen('php://temp', 'r+');
fwrite($handle, $csv);
rewind($handle);
$header = null;
while (($row = fgetcsv($handle)) !== false) {
    if ($header === null) { $header = $row; continue; }
    $rows[] = $row;
}
fclose($handle);

echo "CSV rows: " . count($rows) . "\n";
echo "Header columns: " . count($header) . "\n";
echo "Header: " . implode(' | ', array_map(function($h, $i) { return "$i:$h"; }, $header, array_keys($header))) . "\n\n";

// Show first 3 rows for debugging
for ($i = 0; $i < min(3, count($rows)); $i++) {
    echo "Row $i: " . implode(' | ', array_slice($rows[$i], 0, 10)) . " ...\n";
}
echo "\n";

$created = 0; $skipped = 0; $chipsCreated = 0; $rechips = 0; $errors = [];

$pdo->beginTransaction();
try {
    foreach ($rows as $rowIdx => $cols) {
        while (count($cols) < 40) $cols[] = '';

        $number = trim($cols[0]);
        if (empty($number) || !is_numeric($number)) { $skipped++; continue; }

        $fullChipId = trim($cols[1]);
        if (empty($fullChipId)) { $skipped++; continue; }

        $fullIsoRaw = trim($cols[37] ?? '');
        $reChipFlag = trim($cols[33] ?? '');

        // Build chip_number
        if (!empty($reChipFlag) && !empty($fullIsoRaw)) {
            $shortId = 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $fullChipId), 8, '0', STR_PAD_LEFT);
        } elseif (!empty($fullIsoRaw)) {
            $shortId = 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw);
        } else {
            $shortId = 'LA' . preg_replace('/[^0-9]/', '', $fullChipId);
        }
        if (strlen($shortId) < 4) { $skipped++; continue; }

        $chipDate = trim($cols[2]);
        $sex = trim($cols[3]);
        $vid = trim($cols[4]);
        $chipBox = trim($cols[6]);
        $lifeStage = trim($cols[12]);
        $chipBy = trim($cols[23]);
        $chipAs = trim($cols[24]);
        $chipOk = trim($cols[25]);
        $chickSizeSex = trim($cols[31]);
        $rechipBy = trim($cols[34] ?? '');
        $activeChip2 = trim($cols[35] ?? '');
        $rechipDateRaw = trim($cols[36] ?? '');
        $fullIso = trim($cols[37] ?? '');
        $solo = trim($cols[38] ?? '');
        $kommentar = trim($cols[39] ?? '');

        $parsedDate = null;
        if (!empty($chipDate)) { $ts = strtotime($chipDate); if ($ts) $parsedDate = date('Y-m-d', $ts); }

        $chippedAsAdult = 0;
        if (!empty($chipAs)) $chippedAsAdult = (stripos($chipAs, 'chick') === false) ? 1 : 0;

        $sexNorm = null;
        if (strtoupper($sex) === 'F' || stripos($sex, 'female') !== false) $sexNorm = 'F';
        elseif (strtoupper($sex) === 'M' || stripos($sex, 'male') !== false) $sexNorm = 'M';

        // Insert penguin
        $pdo->prepare("INSERT INTO penguins (peng_num, sex, chipped_as_adult, life_stage, vid_for_scanner, chick_size_code, kommentar) VALUES (?, ?, ?, ?, ?, ?, ?)")
            ->execute([$number, $sexNorm, $chippedAsAdult, $lifeStage ?: null, $vid ?: null, $chickSizeSex ?: null, $kommentar ?: null]);
        $created++;

        // Insert original chip
        $isActive = empty($reChipFlag) ? 1 : 0;
        $pdo->prepare("INSERT INTO penguin_chips (pit_id, peng_num, chip_date, is_active, chip_box, chip_by, solo) VALUES (?, ?, ?, ?, ?, ?, ?)")
            ->execute([$shortId, $number, $parsedDate, $isActive, $chipBox ?: null, $chipBy ?: null, $solo ?: null]);
        $chipsCreated++;

        // Insert rechip if present
        if (!empty($activeChip2) && !empty($reChipFlag)) {
            $rechipFullId = !empty($fullIsoRaw) ? 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw) : 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $activeChip2), 8, '0', STR_PAD_LEFT);

            if ($rechipFullId !== $shortId) {
                $rechipDate = null;
                if (!empty($rechipDateRaw)) { $ts = strtotime($rechipDateRaw); if ($ts) $rechipDate = date('Y-m-d', $ts); }

                $pdo->prepare("INSERT INTO penguin_chips (pit_id, peng_num, chip_date, is_active, rechip_by) VALUES (?, ?, ?, TRUE, ?)")
                    ->execute([$rechipFullId, $number, $rechipDate, $rechipBy ?: null]);
                $rechips++;
                $chipsCreated++;
            }
        }
    }

    $pdo->commit();
    echo "\n=== RESULTS ===\n";
    echo "Created: $created penguins\n";
    echo "Chips: $chipsCreated\n";
    echo "Rechips: $rechips\n";
    echo "Skipped: $skipped\n";

    // Sanity check
    $total = $pdo->query("SELECT COUNT(*) FROM penguins")->fetchColumn();
    $withSex = $pdo->query("SELECT COUNT(*) FROM penguins WHERE sex IS NOT NULL")->fetchColumn();
    $chipCount = $pdo->query("SELECT COUNT(*) FROM penguin_chips")->fetchColumn();

    echo "\n=== SANITY CHECK ===\n";
    echo "Total penguins: $total\n";
    echo "With sex: $withSex\n";
    echo "Total chips: $chipCount\n";

    // Show sample
    $sample = $pdo->query("SELECT p.peng_num, pc.pit_id, p.sex, pc.chip_date, p.life_stage FROM penguins p JOIN penguin_chips pc ON p.peng_num = pc.peng_num WHERE pc.is_active = 1 ORDER BY p.peng_num + 0 LIMIT 5")->fetchAll();
    echo "\nSample:\n";
    foreach ($sample as $s) {
        echo "  #{$s['peng_num']} | {$s['pit_id']} | {$s['sex']} | {$s['chip_date']} | {$s['life_stage']}\n";
    }

} catch (Exception $e) {
    $pdo->rollBack();
    echo "ERROR: " . $e->getMessage() . "\n";
    echo "At row: $rowIdx\n";
    if (isset($cols)) echo "Row data: " . implode(' | ', array_slice($cols, 0, 10)) . "\n";
}
