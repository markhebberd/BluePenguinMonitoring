<?php
/**
 * One-off backfill: observations.monitor_filename -> day_notes, one note per colony per day.
 *
 *   php migrations/2026-07-24c-day-notes-backfill.php              # preview, writes nothing
 *   php migrations/2026-07-24c-day-notes-backfill.php --commit     # write
 *   php migrations/2026-07-24c-day-notes-backfill.php --commit --observer=3
 *
 * monitor_filename was stamped on every row of an import, so a day's ~143 observations carry
 * ~143 copies of one string. This collapses them: for each (colony, NZ date) the distinct
 * cleaned labels are joined, most-used first. Days whose label was pure machine provenance
 * (sheet-import-*, web-entry, a bare timestamp) get no note at all.
 *
 * Cleaning strips the wrapper and the date, never the words. "FM"/"GR"/"BC" are left exactly as
 * the person wrote them — this script does not guess at what an abbreviation means.
 *
 * Writes go through the audited gateway, so the backfill is in audit_log like any other edit,
 * attributed to the --observer given (default: the lowest-numbered admin). Re-runnable: a
 * (colony, date) that already has a note is left alone.
 */

require_once __DIR__ . '/../config.php';   // also pulls in db_write.php (the audited gateway)

if (PHP_SAPI !== 'cli') { http_response_code(403); exit("CLI only\n"); }

$commit = in_array('--commit', $argv, true);
$observerArg = null;
foreach ($argv as $a) if (preg_match('/^--observer=(\d+)$/', $a, $m)) $observerArg = (int)$m[1];

// ww_cleanMonitorLabel() — the filename -> note rule — lives in config.php, shared with the JSON
// import so a re-imported nestcheck file names its day the same way this backfill did.

$pdo = getDbConnection();

// NZ date = UTC + 12 (fixed), matching day.php and the client's utcToNzDate bucketing exactly.
$rows = $pdo->query("SELECT ol.colony_id,
        DATE(o.observation_time_utc + INTERVAL 12 HOUR) AS nz_date,
        o.monitor_filename, COUNT(*) AS n
    FROM observations o
    JOIN observation_locations ol ON ol.location_id = o.location_id
    WHERE o.monitor_filename IS NOT NULL AND o.monitor_filename <> ''
    GROUP BY ol.colony_id, nz_date, o.monitor_filename
    ORDER BY nz_date, ol.colony_id, n DESC")->fetchAll(PDO::FETCH_ASSOC);

// (colony, date) -> [cleaned label => rows carrying it], most-used first.
$byDay = [];
foreach ($rows as $r) {
    $clean = ww_cleanMonitorLabel((string)$r['monitor_filename']);
    if ($clean === '') continue;
    $key = $r['colony_id'] . '|' . $r['nz_date'];
    $byDay[$key][$clean] = ($byDay[$key][$clean] ?? 0) + (int)$r['n'];
}

// Two imports on one day with different labels are two things that happened; keep both rather
// than let the smaller one vanish, joined most-used first. 255 is the column width.
$notes = [];
foreach ($byDay as $key => $labels) {
    arsort($labels);
    $note = mb_substr(implode(' · ', array_keys($labels)), 0, 255);
    [$colonyId, $date] = explode('|', $key);
    $notes[] = ['colony_id' => (int)$colonyId, 'note_date' => $date, 'note' => $note];
}

$existing = [];
foreach ($pdo->query("SELECT colony_id, note_date FROM day_notes") as $e) {
    $existing[$e['colony_id'] . '|' . $e['note_date']] = true;
}

$toWrite = array_values(array_filter($notes, fn($n) => !isset($existing[$n['colony_id'] . '|' . $n['note_date']])));

printf("%d colony-days with a monitor label, %d reduce to a note, %d already have one.\n\n",
    count($byDay), count($notes), count($notes) - count($toWrite));
foreach ($toWrite as $n) printf("  colony %d  %s  %s\n", $n['colony_id'], $n['note_date'], $n['note']);

if (!$commit) {
    printf("\nDry run — nothing written. Re-run with --commit to write %d notes.\n", count($toWrite));
    exit(0);
}
if (!$toWrite) { echo "\nNothing to write.\n"; exit(0); }

$observerId = $observerArg;
if ($observerId === null) {
    $observerId = $pdo->query("SELECT observer_id FROM observers WHERE role = 'admin' ORDER BY observer_id LIMIT 1")->fetchColumn();
    if (!$observerId) exit("No admin observer found — pass --observer=<id>.\n");
}

$pdo->beginTransaction();
try {
    foreach ($toWrite as $n) {
        wwAuditedInsert($pdo, 'day_notes', $n, $observerId, 'Backfilled from observations.monitor_filename');
    }
    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    exit("\nFailed, rolled back: " . $e->getMessage() . "\n");
}
printf("\nWrote %d day notes (audited to observer %d).\n", count($toWrite), $observerId);
