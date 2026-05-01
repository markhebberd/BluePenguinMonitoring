<?php
/**
 * Import penguin reference data from Google Sheets (sheet 2) into the database.
 * Creates/updates penguins + penguin_chips tables.
 *
 * Run via:
 *   php import_penguins.php
 *   curl -H 'X-API-Key: ...' https://wildwatch.co.nz/penguin-api/import_penguins.php
 */
require_once 'config.php';

if (php_sapi_name() !== 'cli') {
    setHeaders();
    validateApiKey();
}

$pdo = getDbConnection();

$csvUrl = 'https://docs.google.com/spreadsheets/d/1A2j56iz0_VNHiWNJORAzGDqTbZsEd76j-YI_gQZsDEE/export?format=csv&gid=143001868';

echo "Downloading sheet 2 from Google Sheets...\n";
$csv = file_get_contents($csvUrl);
if ($csv === false) {
    die(json_encode(['success' => false, 'error' => 'Failed to download CSV']));
}

// Parse CSV (handles multiline quoted fields)
$rows = [];
$handle = fopen('php://temp', 'r+');
fwrite($handle, $csv);
rewind($handle);
$header = null;
while (($row = fgetcsv($handle)) !== false) {
    if ($header === null) {
        $header = $row;
        continue;
    }
    $rows[] = $row;
}
fclose($handle);

echo count($rows) . " data rows parsed\n";

// Column offsets relative to start:
// 0=Number, 1=Chip, 2=ChipDate, 3=Sex, 4=VidForScanner,
// 5=PlusBoxes, 6=ChipBox, 7-11=BreedBox years,
// 12=LifeStage, 13-22=NestSuccess/ReClutch,
// 23=ChipBy, 24=ChipAs, 25=ChipOk, 26=ChipWeight, 27=FlipperLength,
// 28=Persistence, 29=AlarmsScanner, 30=WasSingle, 31=ChickSizeSex,
// 32=ChickReturnDate, 33=ReChip, 34=ReChipBy, 35=ActiveChip2,
// 36=RechipDate, 37=FullIso15Digits

$penguinCount = 0;
$chipCount = 0;
$rechipCount = 0;
$skipped = 0;
$updated = 0;

$pdo->beginTransaction();
try {
    foreach ($rows as $row) {
        $number = trim($row[0] ?? '');
        if (empty($number) || !is_numeric($number)) {
            $skipped++;
            continue;
        }

        $scannedId = trim($row[1] ?? '');
        $chipDateRaw = trim($row[2] ?? '');
        $sex = trim($row[3] ?? '') ?: null;
        $vid = trim($row[4] ?? '') ?: null;
        $lifeStage = trim($row[12] ?? '') ?: 'Adult';
        $chipAs = trim($row[24] ?? '');
        $reChipFlag = trim($row[33] ?? '');
        $activeChip2 = trim($row[35] ?? '');
        $rechipDateRaw = trim($row[36] ?? '');
        $fullIso = trim($row[37] ?? '');

        $chipDate = parseDate($chipDateRaw);
        $chippedAsAdult = (stripos($chipAs, 'Adult') !== false) ? 1 : 0;

        // Extract 8-digit chip ID
        $chipId8 = extractChipId($scannedId);
        if (!$chipId8) {
            $skipped++;
            continue;
        }

        // Check if this penguin already exists by chip number
        $stmt = $pdo->prepare("SELECT p.penguin_id FROM penguins p JOIN penguin_chips pc ON p.penguin_id = pc.penguin_id WHERE pc.chip_number = ?");
        $stmt->execute([$chipId8]);
        $existingId = $stmt->fetchColumn();

        if (!$existingId) {
            // Also check legacy tag_number column
            $stmt = $pdo->prepare("SELECT penguin_id FROM penguins WHERE tag_number = ? OR tag_number = ?");
            $stmt->execute([$chipId8, $fullIso ?: $chipId8]);
            $existingId = $stmt->fetchColumn();
        }

        if ($existingId) {
            // Update existing penguin
            $pdo->prepare("UPDATE penguins SET penguin_number = ?, sex = COALESCE(?, sex), life_stage = COALESCE(?, life_stage), vid_for_scanner = COALESCE(?, vid_for_scanner), initial_chip_date = COALESCE(?, initial_chip_date), chipped_as_adult = ? WHERE penguin_id = ?")
                ->execute([$number, $sex, $lifeStage, $vid, $chipDate, $chippedAsAdult, $existingId]);
            $penguinId = $existingId;
            $updated++;
        } else {
            // Create new penguin
            $pdo->prepare("INSERT INTO penguins (penguin_number, initial_chip_date, chipped_as_adult, sex, life_stage, vid_for_scanner) VALUES (?, ?, ?, ?, ?, ?)")
                ->execute([$number, $chipDate, $chippedAsAdult, $sex, $lifeStage, $vid]);
            $penguinId = $pdo->lastInsertId();
            $penguinCount++;
        }

        // Insert original chip
        $pdo->prepare("INSERT INTO penguin_chips (penguin_id, chip_number, chip_date, is_active) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE penguin_id = VALUES(penguin_id), chip_date = VALUES(chip_date), is_active = VALUES(is_active)")
            ->execute([$penguinId, $chipId8, $chipDate, empty($reChipFlag) ? 1 : 0]);
        $chipCount++;

        // Insert rechip if present
        if (!empty($activeChip2)) {
            $rechipId8 = extractChipId($activeChip2);
            if ($rechipId8 && $rechipId8 !== $chipId8) {
                $rechipDate = parseDate($rechipDateRaw) ?: $chipDate;
                $pdo->prepare("INSERT INTO penguin_chips (penguin_id, chip_number, chip_date, is_active) VALUES (?, ?, ?, TRUE) ON DUPLICATE KEY UPDATE penguin_id = VALUES(penguin_id), chip_date = VALUES(chip_date), is_active = VALUES(is_active)")
                    ->execute([$penguinId, $rechipId8, $rechipDate]);
                $rechipCount++;
            }
        }
    }

    $pdo->commit();

    $result = [
        'success' => true,
        'new_penguins' => $penguinCount,
        'updated_penguins' => $updated,
        'chips' => $chipCount,
        'rechips' => $rechipCount,
        'skipped' => $skipped
    ];
    echo json_encode($result, JSON_PRETTY_PRINT) . "\n";

} catch (Exception $e) {
    $pdo->rollBack();
    $error = ['success' => false, 'error' => $e->getMessage()];
    echo json_encode($error, JSON_PRETTY_PRINT) . "\n";
    if (php_sapi_name() !== 'cli') {
        http_response_code(500);
    }
}

function extractChipId($raw) {
    if (empty($raw)) return null;
    $clean = preg_replace('/[^a-zA-Z0-9]/', '', $raw);
    if (strlen($clean) >= 8) {
        return strtoupper(substr($clean, -8));
    }
    return null;
}

function parseDate($raw) {
    if (empty($raw)) return null;
    $ts = strtotime($raw);
    return $ts !== false ? date('Y-m-d', $ts) : null;
}
