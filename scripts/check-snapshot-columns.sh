#!/usr/bin/env bash
# The snapshot has two paths: a full sync and an incremental one. They must return identically
# shaped rows, because the client PUTs each incoming row over the cached one — a column the
# incremental query omits is not merely missing from that payload, it is deleted from the cache,
# and the row is never re-sent (an incremental only re-sends rows whose updated_at moved), so it
# stays deleted. That is how penguins.alert vanished from clients the moment it was written.
#
# The invariant: in snapshot.php, every SELECT reading one of the entity tables takes its column
# list from a SNAP_COLS_* constant in snapshot_columns.php. Two lists that must agree, kept in
# one place instead of two.
set -euo pipefail

FILE="wildwatch_web/snapshot.php"
[ -f "$FILE" ] || { echo "✗ $FILE not found"; exit 1; }

# Entity tables whose rows land in the client cache keyed by id.
TABLES='observations|penguin_scans|penguins|penguin_chips|observation_locations|penguin_biometric_data'

# Flatten to one line per statement so a SELECT and its FROM are seen together.
# Aggregates (the sync watermark) name tables but return no row shape, so they're exempt.
# So is a select of one bare id column: the field-scope branch picks which observations to send
# before it sends them, and a list of ids is not a row anything caches. The invariant is about
# what lands in the client's stores, and an id on its own never does.
bad=$(tr '\n' ' ' < "$FILE" \
  | grep -oE '(prepare|query)\("SELECT [^"]*"' \
  | grep -vE '\. *SNAP_COLS_' \
  | grep -vE '\("SELECT +(GREATEST|COUNT|MAX|DISTINCT) *\(' \
  | grep -vE '\("SELECT +([a-z0-9_]+\.)?[a-z0-9_]+_id +FROM' \
  | grep -E "FROM +($TABLES)\b" || true)

if [ -n "$bad" ]; then
  echo "✗ snapshot.php selects entity columns without a shared column list:"
  echo "$bad" | sed 's/^/    /'
  echo
  echo "  Use a SNAP_COLS_* constant from snapshot_columns.php. The full and incremental"
  echo "  queries must return the same columns, or a sync silently strips fields out of every"
  echo "  client's cache — and an incremental pass never re-sends those rows to repair them."
  exit 1
fi

echo "✓ snapshot.php builds every entity query from the shared column lists."
