<?php
require_once 'config.php';
setHeaders();
validateApiKey();

$pdo = getDbConnection();
$colonyId = $_GET['colony'] ?? 1;
$report = $_GET['report'] ?? '';

switch ($report) {
    case 'egg_arrival': eggArrival($pdo, $colonyId); break;
    default: echo json_encode(['error' => 'Unknown report']); break;
}

function eggArrival($pdo, $colonyId) {
    // Get all observations with egg counts, ordered by time
    $stmt = $pdo->prepare("SELECT ol.location_name AS box,
        DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) AS obs_date,
        o.eggs
        FROM observations o
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE ol.colony_id = ? AND o.is_deleted = FALSE
        ORDER BY o.observation_time_utc ASC");
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();

    // Group by season, track egg count per box over time
    // For each observation date, compute total eggs in colony (latest obs per box up to that date)
    $seasonData = []; // season => [box => latest_eggs]
    $seasonTimeline = []; // season => [date => total_eggs_snapshot]

    foreach ($rows as $row) {
        $date = $row['obs_date'];
        $m = (int)substr($date, 5, 2);
        $y = (int)substr($date, 0, 4);
        $seasonYear = $m >= 4 ? $y : $y - 1;
        $season = $seasonYear . '/' . substr($seasonYear + 1, -2);

        if (!isset($seasonData[$season])) $seasonData[$season] = [];
        if (!isset($seasonTimeline[$season])) $seasonTimeline[$season] = [];

        // Update this box's egg count
        $seasonData[$season][$row['box']] = (int)$row['eggs'];

        // Snapshot total eggs across all boxes at this date
        $total = array_sum($seasonData[$season]);
        $seasonTimeline[$season][$date] = $total;
    }

    // Convert to chart data
    $result = [];
    foreach ($seasonTimeline as $season => $timeline) {
        $seasonYear = (int)explode('/', $season)[0];
        $seasonStart = "$seasonYear-04-01";

        $data = [];
        foreach ($timeline as $date => $total) {
            $dayOfSeason = (strtotime($date) - strtotime($seasonStart)) / 86400;
            $data[] = ['day' => (int)$dayOfSeason, 'eggs' => $total, 'date' => $date];
        }

        $maxEggs = max(array_column($data, 'eggs'));
        $result[] = [
            'season' => $season,
            'max_eggs' => $maxEggs,
            'data' => $data,
        ];
    }

    usort($result, function($a, $b) { return strcmp($a['season'], $b['season']); });
    echo json_encode($result);
}
