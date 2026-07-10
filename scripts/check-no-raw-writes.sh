#!/usr/bin/env bash
# Enforces the one invariant the data gateway can't enforce itself:
# no PHP file may modify a data table except through wildwatch_web/db_write.php.
#
# The gateway (wwAuditedInsert/Update/Delete/Upsert) writes an audit_log row inside every write,
# so a write that bypasses it is a write nobody can trace. That is the whole point of the file.
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

# Tables the gateway owns. A write to any of these outside db_write.php is a bug.
GUARDED='observations|penguin_scans|penguin_biometric_data|penguins|penguin_chips|observation_locations|regions|colonies|colony_permissions|validation_dismissals|observers|date_mappings|audit_log'

# Deliberate exceptions, each justified:
#   db_write.php    — the gateway itself; its raw SQL is the implementation
#   backup.php      — emits INSERT statements as text into a .sql dump; executes nothing
#   sessions, password_resets, disk_history — infrastructure, not observations

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

# A write statement naming a guarded table, or an interpolated "$table" (the generic crud path).
# -E is deliberate: catch INSERT INTO / INSERT IGNORE INTO / REPLACE INTO / UPDATE x SET / DELETE FROM.
PATTERN="(INSERT[[:space:]]+(IGNORE[[:space:]]+)?INTO|REPLACE[[:space:]]+INTO|DELETE[[:space:]]+FROM)[[:space:]]+\`?(${GUARDED}|\\\$table)|UPDATE[[:space:]]+\`?(${GUARDED}|\\\$table)\`?[[:space:]]+SET"

HITS=$(grep -nEi "$PATTERN" "${CHECK[@]}" 2>/dev/null \
  | grep -vE ':[[:space:]]*(//|#|\*)' )   # ignore comments and docblocks

if [ -n "$HITS" ]; then
  echo "✗ Raw write to a gateway-owned table found outside db_write.php:" >&2
  echo >&2
  echo "$HITS" | sed 's/^/    /' >&2
  echo >&2
  echo "  Use the audited gateway instead — it writes the audit_log row for you:" >&2
  echo "    wwAuditedInsert(\$pdo, 'table', \$row, \$observerId, \$reason)" >&2
  echo "    wwAuditedUpdate(\$pdo, 'table', \$id, \$fields, \$observerId, \$reason)" >&2
  echo "    wwAuditedDelete(\$pdo, 'table', \$id, \$observerId, \$reason)" >&2
  echo "    wwAuditedUpsert(\$pdo, 'table', \$keyCols, \$row, \$observerId, \$reason)" >&2
  echo >&2
  echo "  If this write is genuinely an exception, add it to the list in $0." >&2
  exit 1
fi

exit 0
