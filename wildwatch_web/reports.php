<?php
require_once 'config.php';
setHeaders();
$observer = requireAuth();

$pdo = getDbConnection();
$colonyId = (int)($_GET['colony_id'] ?? $_GET['colony'] ?? 1);
requireColonyAccess($pdo, $observer, $colonyId); // view access to this colony
$report = $_GET['report'] ?? '';

switch ($report) {
    case 'egg_arrival': eggArrival($pdo, $colonyId); break;
    case 'chick_sex': chickSex($pdo, $colonyId); break;
    case 'chick_return': chickReturn($pdo, $colonyId); break;
    case 'distinct_adults': distinctAdults($pdo, $colonyId); break;
    case 'peak_adults': peakAdults($pdo, $colonyId); break;
    case 'chick_sex_both_returned': chickSexBothReturned($pdo, $colonyId); break;
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

function chickSex($pdo, $colonyId) {
    // All penguins chipped as chicks, with their size code and current sex
    $stmt = $pdo->prepare("
        SELECT p.peng_num, p.sex, p.chick_size_code,
            pc.chip_date, pc.chip_box,
            (SELECT COUNT(*) FROM penguin_scans ps2
             JOIN penguin_chips pc2 ON ps2.pit_id = pc2.pit_id
             WHERE pc2.peng_num = p.peng_num AND (ps2.is_deleted = FALSE OR ps2.is_deleted IS NULL)) as total_scans
        FROM penguins p
        JOIN penguin_chips pc ON p.peng_num = pc.peng_num AND pc.is_active = 1
        WHERE p.chipped_as_adult = 0
        AND p.colony_id = ?
        AND p.chick_size_code IN ('LC', 'BC', 'SC')
    ");
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();
    stripPengPrefix($rows, getColonyPrefix($pdo, $colonyId));

    $groups = ['LC' => ['M'=>0,'F'=>0,'U'=>0,'total'=>0,'returned'=>0],
               'BC' => ['M'=>0,'F'=>0,'U'=>0,'total'=>0,'returned'=>0],
               'SC' => ['M'=>0,'F'=>0,'U'=>0,'total'=>0,'returned'=>0]];

    foreach ($rows as $row) {
        $size = $row['chick_size_code'];
        $sex = strtoupper($row['sex'] ?? '');
        if ($sex !== 'M' && $sex !== 'F') $sex = 'U';
        $groups[$size][$sex]++;
        $groups[$size]['total']++;
        if ((int)$row['total_scans'] > 0) $groups[$size]['returned']++;
    }

    echo json_encode($groups);
}

function chickReturn($pdo, $colonyId) {
    // For each chick size, how many were chipped vs returned in a later season
    // First, find the chip season for each bird, then find first scan in a LATER season
    $stmt = $pdo->prepare("
        SELECT p.peng_num, p.chick_size_code, pc.chip_date,
            CASE WHEN MONTH(pc.chip_date) >= 4 THEN YEAR(pc.chip_date) ELSE YEAR(pc.chip_date) - 1 END as chip_season_year,
            (SELECT MIN(DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')))
             FROM penguin_scans ps2
             JOIN penguin_chips pc2 ON ps2.pit_id = pc2.pit_id
             JOIN observations o ON ps2.observation_id = o.observation_id
             WHERE pc2.peng_num = p.peng_num AND o.is_deleted = FALSE AND (ps2.is_deleted = FALSE OR ps2.is_deleted IS NULL)
             AND (CASE WHEN MONTH(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) >= 4
                       THEN YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))
                       ELSE YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) - 1 END)
                 > (CASE WHEN MONTH(pc.chip_date) >= 4 THEN YEAR(pc.chip_date) ELSE YEAR(pc.chip_date) - 1 END)
            ) as first_return_date
        FROM penguins p
        JOIN penguin_chips pc ON p.peng_num = pc.peng_num AND pc.is_active = 1
        WHERE p.chipped_as_adult = 0
        AND p.colony_id = ?
        AND p.chick_size_code IN ('LC', 'BC', 'SC')
    ");
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();
    stripPengPrefix($rows, getColonyPrefix($pdo, $colonyId));

    // Exclude chicks from the previous and current seasons (haven't had a chance to return)
    $now = new DateTime('now', new DateTimeZone('Pacific/Auckland'));
    $curSeasonYear = (int)$now->format('n') >= 4 ? (int)$now->format('Y') : (int)$now->format('Y') - 1;
    $excludeFromYear = $curSeasonYear - 1; // 2025 = 2025/26 season

    // Individual return age data points for scatterplot
    $points = []; // [{size, age, peng_num}]

    // Group by chip season and size
    $bySeasonSize = []; // season => size => {chipped, returned}
    $totals = ['LC' => ['chipped'=>0,'returned'=>0,'return_ages'=>[]],
               'BC' => ['chipped'=>0,'returned'=>0,'return_ages'=>[]],
               'SC' => ['chipped'=>0,'returned'=>0,'return_ages'=>[]]];

    foreach ($rows as $row) {
        $size = $row['chick_size_code'];
        $chipDate = $row['chip_date'];
        if (!$chipDate) continue;
        $chipSeasonYear = (int)$row['chip_season_year'];
        $chipSeason = $chipSeasonYear . '/' . substr($chipSeasonYear + 1, -2);

        if (!isset($bySeasonSize[$chipSeason])) $bySeasonSize[$chipSeason] = [];
        if (!isset($bySeasonSize[$chipSeason][$size])) $bySeasonSize[$chipSeason][$size] = ['chipped'=>0,'returned'=>0];

        $bySeasonSize[$chipSeason][$size]['chipped']++;

        // "Returned" = first scan in a season after chip season
        $returnDate = $row['first_return_date'];
        $returned = !empty($returnDate);
        if ($returned) {
            $bySeasonSize[$chipSeason][$size]['returned']++;
        }

        // Only count toward totals/averages if chick has had at least one full season to return
        if ($chipSeasonYear < $excludeFromYear) {
            $totals[$size]['chipped']++;
            if ($returned) {
                $totals[$size]['returned']++;
                $ageYears = (strtotime($returnDate) - strtotime($chipDate)) / (365.25 * 86400);
                $age = round($ageYears, 1);
                $totals[$size]['return_ages'][] = $age;
                $points[] = ['size' => $size, 'age' => $age, 'peng_num' => $row['peng_num']];
            }
        }
    }

    ksort($bySeasonSize);

    // Compute average return age per size
    $summary = [];
    foreach ($totals as $size => $t) {
        $ages = $t['return_ages'];
        $summary[$size] = [
            'chipped' => $t['chipped'],
            'returned' => $t['returned'],
            'avg_return_age' => count($ages) > 0 ? round(array_sum($ages) / count($ages), 1) : null,
            'median_return_age' => null,
        ];
        if (count($ages) > 0) {
            sort($ages);
            $mid = floor(count($ages) / 2);
            $summary[$size]['median_return_age'] = count($ages) % 2 === 0
                ? round(($ages[$mid - 1] + $ages[$mid]) / 2, 1)
                : $ages[$mid];
        }
    }

    echo json_encode(['by_season' => $bySeasonSize, 'totals' => $summary, 'points' => $points]);
}

function distinctAdults($pdo, $colonyId) {
    // Count distinct adult penguins scanned per breeding season (Apr-Mar)
    $stmt = $pdo->prepare("
        SELECT
            CASE WHEN MONTH(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) >= 4
                 THEN YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))
                 ELSE YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) - 1 END AS season_year,
            ps.pit_id
        FROM penguin_scans ps
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id AND pc.is_active = 1
        JOIN penguins p ON pc.peng_num = p.peng_num
        WHERE ol.colony_id = ? AND o.is_deleted = FALSE AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
          AND (p.chipped_as_adult = 1
               OR (pc.chip_date IS NOT NULL AND DATEDIFF(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'), pc.chip_date) > 90))
        GROUP BY season_year, ps.pit_id
    ");
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();

    $seasons = [];
    foreach ($rows as $row) {
        $sy = (int)$row['season_year'];
        $label = $sy . '/' . substr($sy + 1, -2);
        if (!isset($seasons[$label])) $seasons[$label] = 0;
        $seasons[$label]++;
    }

    ksort($seasons);

    $result = [];
    foreach ($seasons as $season => $count) {
        $result[] = ['season' => $season, 'count' => $count];
    }

    echo json_encode($result);
}

function peakAdults($pdo, $colonyId) {
    // Highest total adults present on a single day, per breeding season (Apr-Mar).
    // A box can be observed more than once a day, so take the max adults per box per
    // day, then sum across boxes for that day's colony total.
    $stmt = $pdo->prepare("
        SELECT season_year, obs_date, SUM(box_adults) AS day_adults
        FROM (
            SELECT
                CASE WHEN MONTH(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) >= 4
                     THEN YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))
                     ELSE YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) - 1 END AS season_year,
                DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) AS obs_date,
                ol.location_name AS box,
                MAX(o.adults) AS box_adults
            FROM observations o
            JOIN observation_locations ol ON o.location_id = ol.location_id
            WHERE ol.colony_id = ? AND o.is_deleted = FALSE
            GROUP BY season_year, obs_date, box
        ) daily
        GROUP BY season_year, obs_date
        ORDER BY season_year, obs_date
    ");
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();

    // Per season, keep the day with the most adults (earliest day wins ties)
    $peak = [];
    foreach ($rows as $row) {
        $sy = (int)$row['season_year'];
        $adults = (int)$row['day_adults'];
        if (!isset($peak[$sy]) || $adults > $peak[$sy]['adults']) {
            $peak[$sy] = ['adults' => $adults, 'date' => $row['obs_date']];
        }
    }

    ksort($peak);

    $result = [];
    foreach ($peak as $sy => $p) {
        $result[] = [
            'season' => $sy . '/' . substr($sy + 1, -2),
            'adults' => $p['adults'],
            'date' => $p['date'],
        ];
    }

    echo json_encode($result);
}

function chickSexBothReturned($pdo, $colonyId) {
    // Find nests where both BC and LC were chipped and both returned in a later season
    // Pair chicks by chip_box + chip_season, require one LC and one BC, both with a return scan
    $stmt = $pdo->prepare("
        SELECT p.peng_num, p.sex, p.chick_size_code, pc.chip_box,
            CASE WHEN MONTH(pc.chip_date) >= 4 THEN YEAR(pc.chip_date) ELSE YEAR(pc.chip_date) - 1 END as chip_season_year,
            (SELECT MIN(DATE(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')))
             FROM penguin_scans ps2
             JOIN penguin_chips pc2 ON ps2.pit_id = pc2.pit_id
             JOIN observations o ON ps2.observation_id = o.observation_id
             WHERE pc2.peng_num = p.peng_num AND o.is_deleted = FALSE AND (ps2.is_deleted = FALSE OR ps2.is_deleted IS NULL)
             AND (CASE WHEN MONTH(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) >= 4
                       THEN YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00'))
                       ELSE YEAR(CONVERT_TZ(o.observation_time_utc, '+00:00', '+12:00')) - 1 END)
                 > (CASE WHEN MONTH(pc.chip_date) >= 4 THEN YEAR(pc.chip_date) ELSE YEAR(pc.chip_date) - 1 END)
            ) as first_return_date
        FROM penguins p
        JOIN penguin_chips pc ON p.peng_num = pc.peng_num AND pc.is_active = 1
        WHERE p.chipped_as_adult = 0
        AND p.colony_id = ?
        AND p.chick_size_code IN ('LC', 'BC')
    ");
    $stmt->execute([$colonyId]);
    $rows = $stmt->fetchAll();
    stripPengPrefix($rows, getColonyPrefix($pdo, $colonyId));

    // Group by nest (chip_box + chip_season)
    $nests = [];
    foreach ($rows as $row) {
        $key = $row['chip_box'] . '|' . $row['chip_season_year'];
        if (!isset($nests[$key])) $nests[$key] = [];
        $nests[$key][] = $row;
    }

    // Filter to nests with both BC and LC, both returned
    $groups = ['LC' => ['M'=>0,'F'=>0,'U'=>0,'total'=>0],
               'BC' => ['M'=>0,'F'=>0,'U'=>0,'total'=>0]];
    $pairs = 0;
    $bothReturnedTotal = 0;

    foreach ($nests as $key => $chicks) {
        $bc = null; $lc = null;
        foreach ($chicks as $c) {
            if ($c['chick_size_code'] === 'BC') $bc = $c;
            if ($c['chick_size_code'] === 'LC') $lc = $c;
        }
        if (!$bc || !$lc) continue;
        if (empty($bc['first_return_date']) || empty($lc['first_return_date'])) continue;

        $bothReturnedTotal++;

        // Only include in chart if one male and one female
        $bcSex = strtoupper($bc['sex'] ?? '');
        $lcSex = strtoupper($lc['sex'] ?? '');
        if (!(($bcSex === 'M' && $lcSex === 'F') || ($bcSex === 'F' && $lcSex === 'M'))) continue;

        $pairs++;
        foreach ([$bc, $lc] as $c) {
            $size = $c['chick_size_code'];
            $sex = strtoupper($c['sex'] ?? '');
            $groups[$size][$sex]++;
            $groups[$size]['total']++;
        }
    }

    echo json_encode(['groups' => $groups, 'pairs' => $pairs, 'both_returned_total' => $bothReturnedTotal]);
}
