<?php
/**
 * Payload contract check — run by deploy.sh after the symlink flip, before the release is kept.
 *
 * Nestcheck deserialises sync.php and penguins.php into typed C# classes. A field that arrives as
 * the wrong JSON type doesn't degrade — Newtonsoft throws, the whole download fails, and the phone
 * retries for thirty seconds and gives up. That is invisible from the server: the request is a 200.
 * It happened on 2026-07-28, when previous-visit boxes started sending the day's whole record where
 * the phone expects the note as a string, and only showed up in the field.
 *
 * So: fetch the real payloads as a real user and assert the shape the app declares. A mismatch
 * fails the deploy, which rolls back.
 *
 * The contract below mirrors nestcheck/Services/DataStorageService.cs (SyncResponse, SyncBox,
 * SyncScan, SyncLocation, SyncUser, SyncObserver) and nestcheck/Models/WildWatchPenguin.cs.
 * When a field is added to one of those classes, add it here.
 *
 * Types: 'int' and 'string' are strict — the C# property is non-nullable, so a JSON null throws on
 * the phone. 'int?' / 'string?' accept null. Missing keys are allowed (the app leaves the default);
 * extra keys are ignored, as Newtonsoft ignores them.
 *
 * Usage: php contract_check.php [colony_id]   (CLI only; exits non-zero on any breach)
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once __DIR__ . '/config.php';

const WW_HOST = 'wildwatch.co.nz';

$BOX = [
    'observation_id' => 'int',   'location_id' => 'int',
    'observation_time_utc' => 'string?', 'monitor_filename' => 'string?', 'day_note' => 'string?',
    'day_observer' => 'string?', 'day_scribe' => 'string?',
    'day_observer_id' => 'int?', 'day_scribe_id' => 'int?',
    'observer_name' => 'string?',
    'adults' => 'int', 'eggs' => 'int', 'chicks' => 'int', 'no_scan' => 'int',
    'failed_eggs' => 'int?', 'dead_chicks' => 'int?',
    'breeding_status' => 'string?', 'gate_status' => 'string?', 'notes' => 'string?',
];
$SCAN = [
    'pit_id' => 'string?', 'scan_time_utc' => 'string?', 'peng_num' => 'string?', 'sex' => 'string?',
    'chick_size_code' => 'string?', 'chipped_as_adult' => 'int?', 'alert' => 'int?',
];
$LOCATION = ['location_id' => 'int', 'location_name' => 'string?', 'persistent_notes' => 'string?', 'watched' => 'int'];
$USER     = ['id' => 'int', 'name' => 'string?', 'f_name' => 'string?', 'surname' => 'string?',
             'chip_acronym' => 'string?', 'falcon_id' => 'string?'];
$OBSERVER = ['observer_id' => 'int', 'name' => 'string?', 'chip_acronym' => 'string?', 'falcon_id' => 'string?'];
$PENGUIN  = ['peng_num' => 'string?', 'pit_id' => 'string?', 'sex' => 'string?', 'is_dead' => 'int?',
             'chip_date' => 'string?', 'chipped_as_adult' => 'int?', 'chick_size_code' => 'string?',
             'sex_guess_m' => 'int?', 'sex_guess_f' => 'int?', 'alert' => 'int?'];

$breaches = [];

function ok($value, string $type): bool {
    $nullable = str_ends_with($type, '?');
    if ($value === null) return $nullable;
    return match (rtrim($type, '?')) {
        // json_decode gives ints for whole numbers; the phone parses "3" into an int too, so a
        // numeric string passes. An array or object never does — that is the failure being caught.
        'int'    => is_int($value) || (is_string($value) && preg_match('/^-?\d+$/', $value) === 1),
        'string' => is_string($value) || is_int($value) || is_float($value) || is_bool($value),
        default  => false,
    };
}

function describe($value): string {
    if (is_array($value)) return array_is_list($value) ? 'array' : 'object';
    return gettype($value);
}

function check(string $where, $row, array $contract): void {
    global $breaches;
    if (!is_array($row)) { $breaches[] = "$where: expected an object, got " . describe($row); return; }
    foreach ($contract as $field => $type) {
        if (!array_key_exists($field, $row)) continue;          // absent is fine; wrong type is not
        if (!ok($row[$field], $type))
            $breaches[] = "$where.$field: expected $type, got " . describe($row[$field]);
    }
}

/** GET an endpoint on this host, resolved to the local nginx so the check hits THIS release. */
function fetchJson(string $path, string $token): array {
    $ch = curl_init("https://" . WW_HOST . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_RESOLVE => [WW_HOST . ':443:127.0.0.1'],
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $token"],
        CURLOPT_TIMEOUT => 30,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) { fwrite(STDERR, "contract: $path request failed: $err\n"); exit(1); }
    if ($status !== 200) { fwrite(STDERR, "contract: $path returned $status\n"); exit(1); }
    $decoded = json_decode($body, true);
    if ($decoded === null) { fwrite(STDERR, "contract: $path is not JSON: " . substr($body, 0, 200) . "\n"); exit(1); }
    return $decoded;
}

$colonyId = (int)($argv[1] ?? 1);
$pdo = getDbConnection();

// A real session for a real user, because that is what the phone has and permissions shape the
// payload. Two minutes, and removed in the finally below however this ends.
$who = $pdo->query("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1")->fetchColumn();
if (!$who) { fwrite(STDERR, "contract: no active admin to check as\n"); exit(1); }
$token = 'contract' . bin2hex(random_bytes(16));
$pdo->prepare("INSERT INTO sessions (token, observer_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 2 MINUTE))")
    ->execute([$token, $who]);

try {
    $sync = fetchJson("/api/sync.php?colony_id=$colonyId", $token);

    check('sync.observer', $sync['observer'] ?? [], $OBSERVER);
    foreach (['boxes', 'previous'] as $group) {
        foreach (($sync[$group] ?? []) as $name => $box) {
            check("sync.$group.$name", $box, $BOX);
            foreach ($box['scans'] ?? [] as $i => $scan) check("sync.$group.$name.scans[$i]", $scan, $SCAN);
        }
    }
    foreach (($sync['locations'] ?? []) as $i => $loc) check("sync.locations[$i]", $loc, $LOCATION);
    foreach (($sync['users'] ?? []) as $i => $u)      check("sync.users[$i]", $u, $USER);

    // A colony with no round today has no previous-visit boxes, and that is exactly the branch
    // that broke — say so rather than passing quietly on an untested half of the payload.
    $prevCount = count($sync['previous'] ?? []);
    if ($prevCount === 0) echo "contract: note — no previous-visit boxes in this payload to check\n";

    foreach (fetchJson("/api/penguins.php", $token) as $i => $p) check("penguins[$i]", $p, $PENGUIN);
} finally {
    $pdo->prepare("DELETE FROM sessions WHERE token = ?")->execute([$token]);
}

if ($breaches) {
    fwrite(STDERR, "CONTRACT FAILED — nestcheck would not parse this payload:\n");
    foreach (array_slice($breaches, 0, 20) as $b) fwrite(STDERR, "  $b\n");
    if (count($breaches) > 20) fwrite(STDERR, "  ... and " . (count($breaches) - 20) . " more\n");
    exit(1);
}

echo "contract OK: " . count($sync['boxes'] ?? []) . " boxes, $prevCount previous, "
   . count($sync['locations'] ?? []) . " locations, " . count($sync['users'] ?? []) . " users\n";
