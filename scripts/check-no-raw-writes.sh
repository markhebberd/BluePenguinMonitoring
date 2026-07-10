#!/usr/bin/env bash
# Enforces the one invariant the data gateway can't enforce itself:
# no PHP file may write to the database at all except wildwatch_web/db_write.php.
#
# Biological tables go through the audited functions (wwAuditedInsert/Update/Delete/Upsert),
# which write an audit_log row inside every write; infrastructure tables (sessions,
# password_resets, disk_history) go through the named unaudited helpers in the same file.
# Either way, a write outside that file is a write nobody can trace or reason about.
#
# Run by the deploy workflow (.github/workflows/deploy-wildwatch.yml): a raw write fails
# the check job and the deploy never triggers.
#
# Usage:
#   scripts/check-no-raw-writes.sh              # check every tracked PHP file
#   scripts/check-no-raw-writes.sh a.php b.php  # check specific files
#
# Exit 0 = clean, 1 = a raw write was found.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

# Exempt files, each justified:
#   db_write.php    — the gateway itself; its raw SQL is the implementation
#   backup.php      — emits INSERT statements as text into a .sql dump; executes nothing

if [ $# -gt 0 ]; then
  FILES=("$@")
else
  # No mapfile — macOS ships bash 3.2.
  FILES=()
  while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files '*.php')
fi

# Only look at files that still exist (a staged deletion has no worktree file).
CHECK=()
for f in "${FILES[@]}"; do
  case "$f" in
    *db_write.php|*backup.php) continue ;;
    *.php) [ -f "$f" ] && CHECK+=("$f") ;;
  esac
done
[ ${#CHECK[@]} -eq 0 ] && exit 0

# Any SQL write statement, to any table. No table allowlist to maintain: a new table is
# covered the day it exists. -E is deliberate: catch INSERT INTO / INSERT IGNORE INTO /
# REPLACE INTO / UPDATE x SET / DELETE FROM (including an interpolated "$table").
PATTERN="(INSERT[[:space:]]+(IGNORE[[:space:]]+)?INTO|REPLACE[[:space:]]+INTO|DELETE[[:space:]]+FROM)[[:space:]]+\`?[a-zA-Z_\$]|UPDATE[[:space:]]+\`?[a-zA-Z_\$][a-zA-Z0-9_\`]*[[:space:]]+SET[[:space:]]"

HITS=$(grep -nEi "$PATTERN" "${CHECK[@]}" 2>/dev/null \
  | grep -vE ':[[:space:]]*(//|#|\*)' )   # ignore comments and docblocks

if [ -n "$HITS" ]; then
  echo "✗ SQL write found outside db_write.php:" >&2
  echo >&2
  echo "$HITS" | sed 's/^/    /' >&2
  echo >&2
  echo "  All writes live in wildwatch_web/db_write.php. For biological tables use the" >&2
  echo "  audited gateway — it writes the audit_log row for you:" >&2
  echo "    wwAuditedInsert(\$pdo, 'table', \$row, \$observerId, \$reason)" >&2
  echo "    wwAuditedUpdate(\$pdo, 'table', \$id, \$fields, \$observerId, \$reason)" >&2
  echo "    wwAuditedDelete(\$pdo, 'table', \$id, \$observerId, \$reason)" >&2
  echo "    wwAuditedUpsert(\$pdo, 'table', \$keyCols, \$row, \$observerId, \$reason)" >&2
  echo "  For infrastructure (sessions, password resets, disk history) add or use a named" >&2
  echo "  unaudited helper there instead." >&2
  exit 1
fi

exit 0
