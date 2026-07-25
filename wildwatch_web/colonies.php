<?php
/**
 * Colonies API — returns colonies available to the authenticated user.
 *
 * GET /api/colonies.php
 * Returns: [{ colony_id, colony_name, region_name, location_sets_string }]
 */
require_once 'config.php';
header('Content-Type: application/json');
header('Cache-Control: no-cache');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$pdo = getDbConnection();

// Login required — the colony list is not public. The SPA fetches this only after login
// (loadColony), so requiring auth costs nothing and stops anonymous callers enumerating
// colony names/regions.
$observer = requireAuth($pdo);

if ($observer && ($observer['role'] ?? '') !== 'admin') {
    // Non-admin: only colonies this user has explicit permission for
    $stmt = $pdo->prepare("SELECT c.colony_id, c.region_id, c.colony_name, c.colony_prefix, c.location_sets_string, r.region_name
        FROM colonies c
        JOIN regions r ON c.region_id = r.region_id
        JOIN colony_permissions cp ON c.colony_id = cp.colony_id
        WHERE cp.observer_id = ?
        ORDER BY r.region_name, c.colony_name");
    $stmt->execute([$observer['observer_id']]);
    $colonies = $stmt->fetchAll();

    // No permissions = no colonies
} else {
    // Admins get every colony (consistent with requireColonyAccess in config.php).
    $stmt = $pdo->query("SELECT c.colony_id, c.region_id, c.colony_name, c.colony_prefix, c.location_sets_string, r.region_name
        FROM colonies c JOIN regions r ON c.region_id = r.region_id
        ORDER BY r.region_name, c.colony_name");
    $colonies = $stmt->fetchAll();
}

echo json_encode($colonies);
