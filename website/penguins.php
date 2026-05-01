<?php
/**
 * Penguins API
 *
 * GET /penguin-api/penguins.php                - All penguins with stats
 * GET /penguin-api/penguins.php?chip_id=X      - Lookup by chip ID
 * GET /penguin-api/penguins.php?penguin_id=X   - Lookup by penguin ID
 *
 * No API key required - public read-only endpoint.
 */
require_once 'config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=300');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$pdo = getDbConnection();

$chipId = $_GET['chip_id'] ?? null;
$penguinId = $_GET['penguin_id'] ?? null;

if ($chipId) {
    handleChipLookup($pdo, $chipId);
} elseif ($penguinId) {
    handlePenguinLookup($pdo, $penguinId);
} else {
    handleAll($pdo);
}

function handleChipLookup($pdo, $chipId) {
    $chipId = strtoupper(preg_replace('/[^a-zA-Z0-9]/', '', $chipId));

    $stmt = $pdo->prepare("
        SELECT p.*, pc.chip_number, pc.chip_date AS chip_chip_date, pc.is_active
        FROM penguins p
        JOIN penguin_chips pc ON p.penguin_id = pc.penguin_id
        WHERE pc.chip_number = ?
    ");
    $stmt->execute([$chipId]);
    $row = $stmt->fetch();

    if ($row) {
        echo json_encode(formatPenguin($pdo, $row));
    } else {
        // Fallback: check legacy tag_number
        $stmt = $pdo->prepare("SELECT * FROM penguins WHERE tag_number LIKE ?");
        $stmt->execute(['%' . $chipId]);
        $row = $stmt->fetch();

        if ($row) {
            echo json_encode(formatPenguin($pdo, $row));
        } else {
            http_response_code(404);
            echo json_encode(['error' => 'Penguin not found']);
        }
    }
}

function handlePenguinLookup($pdo, $penguinId) {
    $stmt = $pdo->prepare("SELECT * FROM penguins WHERE penguin_id = ?");
    $stmt->execute([$penguinId]);
    $row = $stmt->fetch();

    if ($row) {
        echo json_encode(formatPenguin($pdo, $row));
    } else {
        http_response_code(404);
        echo json_encode(['error' => 'Penguin not found']);
    }
}

function handleAll($pdo) {
    $sql = "SELECT p.*,
                COUNT(DISTINCT ps.scan_id) AS total_scans,
                COUNT(DISTINCT ol.location_id) AS boxes_seen,
                MAX(ps.scan_time_utc) AS last_seen
            FROM penguins p
            LEFT JOIN penguin_scans ps ON p.penguin_id = ps.penguin_id
            LEFT JOIN observations o ON ps.observation_id = o.observation_id AND o.is_deleted = FALSE
            LEFT JOIN observation_locations ol ON o.location_id = ol.location_id
            GROUP BY p.penguin_id
            ORDER BY last_seen DESC";

    $stmt = $pdo->query($sql);
    $penguins = $stmt->fetchAll();

    $result = [];
    foreach ($penguins as $row) {
        $result[] = [
            'penguin_id' => (int)$row['penguin_id'],
            'penguin_number' => $row['penguin_number'],
            'tag_number' => $row['tag_number'],
            'sex' => $row['sex'],
            'life_stage' => $row['life_stage'],
            'chip_date' => $row['chip_date'] ?? $row['initial_chip_date'],
            'initial_chip_date' => $row['initial_chip_date'],
            'chipped_as_adult' => (int)($row['chipped_as_adult'] ?? 0),
            'vid_for_scanner' => $row['vid_for_scanner'],
            'total_scans' => (int)$row['total_scans'],
            'boxes_seen' => (int)$row['boxes_seen'],
            'last_seen' => $row['last_seen'],
            'chips' => getChips($row['penguin_id'], $pdo)
        ];
    }

    echo json_encode($result);
}

function formatPenguin($pdo, $row) {
    $penguinId = $row['penguin_id'];

    // Get scan stats
    $stmt = $pdo->prepare("
        SELECT COUNT(DISTINCT ps.scan_id) AS total_scans,
               COUNT(DISTINCT ol.location_id) AS boxes_seen,
               MAX(ps.scan_time_utc) AS last_seen
        FROM penguin_scans ps
        LEFT JOIN observations o ON ps.observation_id = o.observation_id AND o.is_deleted = FALSE
        LEFT JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ps.penguin_id = ?
    ");
    $stmt->execute([$penguinId]);
    $stats = $stmt->fetch();

    return [
        'penguin_id' => (int)$penguinId,
        'penguin_number' => $row['penguin_number'] ?? null,
        'tag_number' => $row['tag_number'] ?? null,
        'sex' => $row['sex'],
        'life_stage' => $row['life_stage'],
        'chip_date' => $row['chip_date'] ?? $row['initial_chip_date'] ?? null,
        'initial_chip_date' => $row['initial_chip_date'] ?? null,
        'chipped_as_adult' => (int)($row['chipped_as_adult'] ?? 0),
        'vid_for_scanner' => $row['vid_for_scanner'],
        'total_scans' => (int)($stats['total_scans'] ?? 0),
        'boxes_seen' => (int)($stats['boxes_seen'] ?? 0),
        'last_seen' => $stats['last_seen'],
        'chips' => getChips($penguinId, $pdo)
    ];
}

function getChips($penguinId, $pdo) {
    $stmt = $pdo->prepare("SELECT chip_number, chip_date, is_active FROM penguin_chips WHERE penguin_id = ? ORDER BY chip_date");
    $stmt->execute([$penguinId]);
    $chips = [];
    foreach ($stmt->fetchAll() as $c) {
        $chips[] = [
            'chip_number' => $c['chip_number'],
            'chip_date' => $c['chip_date'],
            'is_active' => (bool)$c['is_active']
        ];
    }
    return $chips;
}

