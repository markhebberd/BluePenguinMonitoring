<?php
/**
 * Import penguin reference data from Google Sheets (sheet 2) into the database.
 * Populates penguins + penguin_chips tables, including rechip data.
 *
 * Run via:
 *   curl -H 'X-API-Key: ...' https://wildwatch.co.nz/penguin-api/import_penguins.php
 */
require_once 'config.php';
setHeaders();
validateApiKey();
$pdo = getDbConnection();

$csvUrl = 'https://docs.google.com/spreadsheets/d/1A2j56iz0_VNHiWNJORAzGDqTbZsEd76j-YI_gQZsDEE/export?format=csv&gid=143001868';

$csv = file_get_contents($csvUrl);
if (!$csv) { echo json_encode(['error' => 'Failed to download CSV']); exit; }

// Parse CSV properly (handles multiline quoted fields)
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

$updated = 0; $created = 0; $skipped = 0; $chipsCreated = 0; $rechips = 0;

$pdo->beginTransaction();
try {
    foreach ($rows as $cols) {
        while (count($cols) < 38) $cols[] = '';

        $number = trim($cols[0]);
        if (empty($number) || !is_numeric($number)) { $skipped++; continue; }

        $fullChipId = trim($cols[1]);
        if (empty($fullChipId) || strlen($fullChipId) < 8) { $skipped++; continue; }

        $clean = preg_replace('/[^A-Za-z0-9]/', '', $fullChipId);
        $shortId = strlen($clean) >= 8 ? strtoupper(substr($clean, -8)) : strtoupper($clean);

        $chipDate = trim($cols[2]);
        $sex = trim($cols[3]);
        $vid = trim($cols[4]);
        $lifeStage = trim($cols[12]);
        $chipAs = trim($cols[24]);
        $reChipFlag = trim($cols[33]);
        $activeChip2 = trim($cols[35]);
        $rechipDateRaw = trim($cols[36]);
        $fullIso = trim($cols[37]);

        $parsedDate = null;
        if (!empty($chipDate)) { $ts = strtotime($chipDate); if ($ts) $parsedDate = date('Y-m-d', $ts); }

        $chippedAsAdult = 0;
        if (!empty($chipAs)) $chippedAsAdult = (stripos($chipAs, 'chick') === false) ? 1 : 0;

        $sexNorm = null;
        if (strtoupper($sex) === 'F' || stripos($sex, 'female') !== false) $sexNorm = 'F';
        elseif (strtoupper($sex) === 'M' || stripos($sex, 'male') !== false) $sexNorm = 'M';

        // Find existing penguin by chip or tag_number
        $stmt = $pdo->prepare("SELECT penguin_id FROM penguin_chips WHERE chip_number = ?");
        $stmt->execute([$shortId]);
        $existing = $stmt->fetchColumn();

        if (!$existing) {
            $stmt = $pdo->prepare("SELECT penguin_id FROM penguins WHERE tag_number = ?");
            $stmt->execute([$shortId]);
            $existing = $stmt->fetchColumn();
        }

        if ($existing) {
            $pdo->prepare("UPDATE penguins SET penguin_number = ?, sex = COALESCE(?, sex), initial_chip_date = COALESCE(?, initial_chip_date), chip_date = COALESCE(?, chip_date), chipped_as_adult = ?, life_stage = COALESCE(?, life_stage), vid_for_scanner = COALESCE(?, vid_for_scanner) WHERE penguin_id = ?")
                ->execute([$number, $sexNorm, $parsedDate, $parsedDate, $chippedAsAdult, $lifeStage ?: null, $vid ?: null, $existing]);
            $penguinId = $existing;
            $updated++;
        } else {
            $pdo->prepare("INSERT INTO penguins (penguin_number, tag_number, sex, initial_chip_date, chip_date, chipped_as_adult, life_stage, vid_for_scanner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([$number, $shortId, $sexNorm, $parsedDate, $parsedDate, $chippedAsAdult, $lifeStage ?: null, $vid ?: null]);
            $penguinId = $pdo->lastInsertId();
            $created++;
        }

        // Insert original chip
        $isActive = empty($reChipFlag) ? 1 : 0;
        $pdo->prepare("INSERT INTO penguin_chips (penguin_id, chip_number, chip_date, is_active) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE penguin_id = VALUES(penguin_id), chip_date = VALUES(chip_date), is_active = VALUES(is_active)")
            ->execute([$penguinId, $shortId, $parsedDate, $isActive]);
        $chipsCreated++;

        // Insert rechip if present
        if (!empty($activeChip2)) {
            $cleanRechip = preg_replace('/[^A-Za-z0-9]/', '', $activeChip2);
            $rechipId = strlen($cleanRechip) >= 8 ? strtoupper(substr($cleanRechip, -8)) : strtoupper($cleanRechip);
            if (strlen($rechipId) >= 8 && $rechipId !== $shortId) {
                $rechipDate = null;
                if (!empty($rechipDateRaw)) { $ts = strtotime($rechipDateRaw); if ($ts) $rechipDate = date('Y-m-d', $ts); }

                $pdo->prepare("INSERT INTO penguin_chips (penguin_id, chip_number, chip_date, is_active) VALUES (?, ?, ?, TRUE) ON DUPLICATE KEY UPDATE penguin_id = VALUES(penguin_id), chip_date = VALUES(chip_date), is_active = VALUES(is_active)")
                    ->execute([$penguinId, $rechipId, $rechipDate]);
                $rechips++;
                $chipsCreated++;
            }
        }
    }

    $pdo->commit();
    echo json_encode([
        'success' => true,
        'created' => $created,
        'updated' => $updated,
        'chips' => $chipsCreated,
        'rechips' => $rechips,
        'skipped' => $skipped,
        'total_rows' => count($rows)
    ], JSON_PRETTY_PRINT);
} catch (Exception $e) {
    $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
