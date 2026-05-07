<?php
/**
 * Database Configuration for BoxTags API
 *
 * INSTRUCTIONS:
 * 1. Copy this file to your cPanel server at: public_html/penguin-api/config.php
 * 2. Update the database credentials below
 * 3. Generate a secure API key (32+ characters) and set it below
 * 4. Ensure this file is NOT accessible directly from web (or move outside public_html)
 */

// Database credentials - UPDATE THESE
define('DB_HOST', 'localhost');
define('DB_NAME', 'wildwatch_nestcheck');
define('DB_USER', 'wildwatch_nestcheck_api');       // Update this
define('DB_PASS', '9_?KPS7U~h7Pt_=K');              // Update this

// API Key for authentication - GENERATE A SECURE KEY
// Use: https://randomkeygen.com/ or similar to generate a 32+ character key
define('API_KEY', 'tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf');

// CORS settings (adjust for production)
define('ALLOWED_ORIGIN', '*');  // In production, set to your specific domain

/**
 * Get database connection with retry logic for shared hosting
 *
 * @param int $attemptsRemaining Number of retry attempts remaining
 * @return PDO Database connection
 */
function getDbConnection($attemptsRemaining = 4) {
    try {
        $pdo = new PDO(
            "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
            DB_USER,
            DB_PASS,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                // Shared hosting optimizations
                PDO::ATTR_PERSISTENT => false,  // Avoid stale connections on shared hosting
                PDO::ATTR_TIMEOUT => 5,          // Connection timeout (5 seconds)
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET SESSION wait_timeout=30"  // Keep session alive
            ]
        );
        return $pdo;
    } catch (PDOException $e) {
        // Retry if MySQL connection timed out (common on cheap shared hosting)
        if ($attemptsRemaining > 0 && (
            strpos($e->getMessage(), 'gone away') !== false ||
            strpos($e->getMessage(), 'timeout') !== false ||
            strpos($e->getMessage(), 'Lost connection') !== false
        )) {
            $attemptNumber = 5 - $attemptsRemaining;
            error_log("Database connection attempt {$attemptNumber} failed, retrying... ({$attemptsRemaining} attempts remaining)");
            usleep(500000);  // Wait 500ms before retry
            return getDbConnection($attemptsRemaining - 1);
        }

        // Log the actual error for debugging (visible in PHP error logs)
        error_log("Database connection failed after all retries: " . $e->getMessage());

        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database connection failed']);
        exit;
    }
}

/**
 * Validate API key from request header
 */
function validateApiKey() {
    $headers = getallheaders();
    $apiKey = $headers['X-API-Key'] ?? $headers['x-api-key'] ?? '';

    if ($apiKey !== API_KEY) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Invalid API key']);
        exit;
    }
}

/**
 * Set CORS and JSON headers
 */
function setHeaders() {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: ' . ALLOWED_ORIGIN);
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-API-Key');

    // Handle preflight requests
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(200);
        exit;
    }
}
/**
 * Get all penguin sightings: scans + chip events, deduplicated by date+box.
 * Filter by penguin OR box (or both). Returns array sorted newest first.
 * Each entry: peng_num, pit_id, sex, chipped_as_adult, chick_size_code, chip_date,
 *   date, box, source, adults, eggs, chicks, breeding_status, notes, seen_with[],
 *   is_chipped_here, chip_by, scan_count.
 */
function getSightings($pdo, $pengNum = null, $boxName = null, $colonyId = 1) {
    // Build scan query with optional filters
    $where = ['o.is_deleted = FALSE'];
    $params = [];
    if ($pengNum) { $where[] = 'pc.peng_num = ?'; $params[] = $pengNum; }
    if ($boxName) { $where[] = 'ol.location_name = ?'; $params[] = $boxName; $where[] = 'ol.colony_id = ?'; $params[] = $colonyId; }
    $whereStr = implode(' AND ', $where);

    $stmt = $pdo->prepare("SELECT ps.pit_id, pc.peng_num, p.sex, p.life_stage, p.chipped_as_adult, p.chick_size_code,
        pc.chip_date, o.observation_id, ol.location_name AS box_name, o.observation_time_utc,
        o.adults, o.eggs, o.chicks, o.breeding_status, o.notes
        FROM penguin_scans ps
        JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
        JOIN penguins p ON pc.peng_num = p.peng_num
        JOIN observations o ON ps.observation_id = o.observation_id
        JOIN observation_locations ol ON o.location_id = ol.location_id
        WHERE $whereStr
        ORDER BY o.observation_time_utc DESC");
    $stmt->execute($params);
    $scans = $stmt->fetchAll();

    // Co-scanned birds per observation (only for penguin queries, too expensive for box queries)
    $coScans = [];
    if ($pengNum) {
        $obsIds = array_unique(array_column($scans, 'observation_id'));
        if (!empty($obsIds)) {
            $ph = implode(',', array_fill(0, count($obsIds), '?'));
            $coStmt = $pdo->prepare("SELECT ps.observation_id, pc.peng_num, p.sex, p.chipped_as_adult, pc.pit_id, pc.chip_date, p.chick_size_code
                FROM penguin_scans ps
                JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
                JOIN penguins p ON pc.peng_num = p.peng_num
                WHERE ps.observation_id IN ($ph) AND pc.peng_num != ?
                ORDER BY pc.peng_num + 0");
            $coStmt->execute(array_merge($obsIds, [$pengNum]));
            foreach ($coStmt->fetchAll() as $row) {
                $coScans[$row['observation_id']][] = $row;
            }
        }
    }

    // Build penguin map and sighting list
    $penguins = []; // peng_num => summary
    $sightings = []; // deduped by peng+date+box
    foreach ($scans as $s) {
        $pnum = $s['peng_num'];
        $date = substr($s['observation_time_utc'], 0, 10);
        $key = $pnum . '|' . $date . '|' . $s['box_name'];

        if (!isset($penguins[$pnum])) {
            $penguins[$pnum] = [
                'peng_num' => $pnum, 'pit_id' => $s['pit_id'], 'sex' => $s['sex'],
                'life_stage' => $s['life_stage'], 'chipped_as_adult' => $s['chipped_as_adult'],
                'chick_size_code' => $s['chick_size_code'], 'chip_date' => $s['chip_date'],
                'scan_count' => 0, 'last_seen' => $s['observation_time_utc'], 'is_chipped_here' => false,
            ];
        }
        $penguins[$pnum]['scan_count']++;

        if (!isset($sightings[$key])) {
            $sightings[$key] = [
                'peng_num' => $pnum, 'date' => $s['observation_time_utc'], 'box' => $s['box_name'],
                'source' => 'scan', 'adults' => (int)$s['adults'], 'eggs' => (int)$s['eggs'],
                'chicks' => (int)$s['chicks'], 'breeding_status' => $s['breeding_status'],
                'notes' => $s['notes'], 'seen_with' => $coScans[$s['observation_id']] ?? [],
            ];
        }
    }

    // Add chip events
    $chipWhere = [];
    $chipParams = [];
    if ($pengNum) { $chipWhere[] = 'pc.peng_num = ?'; $chipParams[] = $pengNum; }
    if ($boxName) { $chipWhere[] = 'pc.chip_box = ?'; $chipParams[] = $boxName; }
    if (!empty($chipWhere)) {
        $chipStmt = $pdo->prepare("SELECT pc.pit_id, pc.peng_num, p.sex, p.life_stage, p.chipped_as_adult, p.chick_size_code,
            pc.chip_date, pc.chip_box, pc.chip_by
            FROM penguin_chips pc JOIN penguins p ON pc.peng_num = p.peng_num
            WHERE " . implode(' AND ', $chipWhere) . " ORDER BY pc.chip_date");
        $chipStmt->execute($chipParams);
        foreach ($chipStmt->fetchAll() as $c) {
            $pnum = $c['peng_num'];
            if (!isset($penguins[$pnum])) {
                $penguins[$pnum] = [
                    'peng_num' => $pnum, 'pit_id' => $c['pit_id'], 'sex' => $c['sex'],
                    'life_stage' => $c['life_stage'], 'chipped_as_adult' => $c['chipped_as_adult'],
                    'chick_size_code' => $c['chick_size_code'], 'chip_date' => $c['chip_date'],
                    'scan_count' => 0, 'last_seen' => $c['chip_date'], 'is_chipped_here' => false,
                ];
            }
            if ($boxName && $c['chip_box'] === $boxName) {
                $penguins[$pnum]['is_chipped_here'] = true;
                $penguins[$pnum]['chip_by'] = $c['chip_by'];
            }

            if ($c['chip_box'] && $c['chip_date']) {
                $key = $pnum . '|' . $c['chip_date'] . '|' . $c['chip_box'];
                if (!isset($sightings[$key])) {
                    $sightings[$key] = [
                        'peng_num' => $pnum, 'date' => $c['chip_date'], 'box' => $c['chip_box'],
                        'source' => 'chip', 'adults' => 0, 'eggs' => 0, 'chicks' => 0,
                        'breeding_status' => null, 'notes' => 'Chipped by ' . ($c['chip_by'] ?? ''),
                        'seen_with' => [],
                    ];
                }
            }
        }
    }

    usort($sightings, function($a, $b) { return strcmp($b['date'], $a['date']); });
    return ['penguins' => array_values($penguins), 'sightings' => array_values($sightings)];
}
?>
