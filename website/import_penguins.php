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

$csv = @file_get_contents($csvUrl);
if (!$csv) {
    $csv = null; // NO STALE FALLBACK
}
if (!$csv) { echo json_encode(['error' => 'No CSV source available']); exit; }

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
        while (count($cols) < 40) $cols[] = '';

        $number = trim($cols[0]);
        if (empty($number) || !is_numeric($number)) { $skipped++; continue; }

        $fullChipId = trim($cols[1]);
        if (empty($fullChipId)) { $skipped++; continue; }

        $fullIsoRaw = trim($cols[37]);
        $reChipFlag = trim($cols[33]);

        // Build full chip_number as LA + 15 digits
        // full_iso contains the ACTIVE chip's full number
        // For rechipped penguins, that's the rechip - original is LA95600000 + col 1
        if (!empty($reChipFlag) && !empty($fullIsoRaw)) {
            // Rechipped: original chip = LA95600000 + 8-digit col 1
            $shortId = 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $fullChipId), 8, '0', STR_PAD_LEFT);
        } elseif (!empty($fullIsoRaw)) {
            // Normal: full_iso IS this chip
            $shortId = 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw);
        } else {
            // Fallback
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
        $reChipFlag = trim($cols[33]);
        $rechipBy = trim($cols[34]);
        $activeChip2 = trim($cols[35]);
        $rechipDateRaw = trim($cols[36]);
        $fullIso = trim($cols[37]);
        $solo = trim($cols[38]);
        $kommentar = trim($cols[39]);

        $parsedDate = null;
        if (!empty($chipDate)) { $ts = strtotime($chipDate); if ($ts) $parsedDate = date('Y-m-d', $ts); }

        $chippedAsAdult = 0;
        if (!empty($chipAs)) $chippedAsAdult = (stripos($chipAs, 'chick') === false) ? 1 : 0;

        $sexNorm = null;
        if (strtoupper($sex) === 'F' || stripos($sex, 'female') !== false) $sexNorm = 'F';
        elseif (strtoupper($sex) === 'M' || stripos($sex, 'male') !== false) $sexNorm = 'M';

        // Find existing penguin by pit_id
        $stmt = $pdo->prepare("SELECT peng_num FROM penguin_chips WHERE pit_id = ?");
        $stmt->execute([$shortId]);
        $existing = $stmt->fetchColumn();

        if (!$existing) {
            $last8 = substr(preg_replace('/[^0-9]/', '', $shortId), -8);
            $stmt = $pdo->prepare("SELECT peng_num FROM penguin_chips WHERE pit_id LIKE ?");
            $stmt->execute(['%' . $last8]);
            $existing = $stmt->fetchColumn();
        }

        if ($existing) {
            $pdo->prepare("UPDATE penguins SET peng_num = ?, sex = COALESCE(?, sex), chipped_as_adult = ?, life_stage = COALESCE(?, life_stage), vid_for_scanner = COALESCE(?, vid_for_scanner), chick_size_code = COALESCE(?, chick_size_code), kommentar = COALESCE(?, kommentar) WHERE peng_num = ?")
                ->execute([$number, $sexNorm, $chippedAsAdult, $lifeStage ?: null, $vid ?: null, $chickSizeSex ?: null, $kommentar ?: null, $existing]);
            $updated++;
        } else {
            $pdo->prepare("INSERT INTO penguins (peng_num, sex, chipped_as_adult, life_stage, vid_for_scanner, chick_size_code, kommentar) VALUES (?, ?, ?, ?, ?, ?, ?)")
                ->execute([$number, $sexNorm, $chippedAsAdult, $lifeStage ?: null, $vid ?: null, $chickSizeSex ?: null, $kommentar ?: null]);
            $created++;
        }

        // Insert original chip
        $isActive = empty($reChipFlag) ? 1 : 0;
        $pdo->prepare("INSERT INTO penguin_chips (pit_id, peng_num, chip_date, is_active, chip_box, chip_by, rechip_by, solo) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) ON DUPLICATE KEY UPDATE chip_date = VALUES(chip_date), is_active = VALUES(is_active), chip_box = VALUES(chip_box), chip_by = VALUES(chip_by), solo = VALUES(solo)")
            ->execute([$shortId, $number, $parsedDate, $isActive, $chipBox ?: null, $chipBy ?: null, $solo ?: null]);
        $chipsCreated++;

        // Insert rechip if present
        if (!empty($activeChip2) && !empty($reChipFlag)) {
            $rechipFullId = !empty($fullIsoRaw) ? 'LA' . preg_replace('/[^0-9]/', '', $fullIsoRaw) : 'LA9560000' . str_pad(preg_replace('/[^0-9]/', '', $activeChip2), 8, '0', STR_PAD_LEFT);

            if ($rechipFullId !== $shortId) {
                $rechipDate = null;
                if (!empty($rechipDateRaw)) { $ts = strtotime($rechipDateRaw); if ($ts) $rechipDate = date('Y-m-d', $ts); }

                $pdo->prepare("INSERT INTO penguin_chips (pit_id, peng_num, chip_date, is_active, rechip_by) VALUES (?, ?, ?, TRUE, ?) ON DUPLICATE KEY UPDATE chip_date = VALUES(chip_date), is_active = VALUES(is_active), rechip_by = VALUES(rechip_by)")
                    ->execute([$rechipFullId, $number, $rechipDate, $rechipBy ?: null]);
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
