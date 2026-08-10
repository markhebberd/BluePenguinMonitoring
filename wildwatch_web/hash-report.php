<?php
/**
 * Diagnostic sink for client cache-hash mismatches (see snapshot_hash.php). When the web client's
 * cached table hash disagrees with the server's, it full-re-syncs and POSTs the row/field diffs
 * here — so we can find the incremental-sync method that stranded the row.
 *
 * A disposable working log, NOT a record: it appends to hash-mismatch.log and rotates at a size cap
 * (one .1 backup, then overwrite), so it can never grow unbounded the way #39's sync_debug.log did.
 */
require_once 'config.php';
header('Content-Type: application/json');

$observer = requireAuth(); // authenticated, so it can't be spammed anonymously

$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) { http_response_code(400); echo json_encode(['error' => 'JSON body required']); exit; }

$file = __DIR__ . '/hash-mismatch.log';
$max  = 1000000; // ~1 MB, then rotate to .1 — a bounded working file, not an archive
if (@filesize($file) > $max) @rename($file, $file . '.1');

$line = date('Y-m-d H:i:s')
    . ' obs=' . (int)($observer['observer_id'] ?? 0)
    . ' colony=' . (int)($in['colony_id'] ?? 0)
    . ' ver=' . preg_replace('/[^\w.\-]/', '', (string)($in['client_version'] ?? '?'))
    . ' ' . json_encode($in['diffs'] ?? $in, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
    . "\n";
@file_put_contents($file, $line, FILE_APPEND | LOCK_EX);

echo json_encode(['ok' => true]);
