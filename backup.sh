#!/bin/bash
# Daily database backup from wildwatch.co.nz
# Usage: ./backup.sh          (today's backup)
#        ./backup.sh 2026-05-01 (specific date label)
#
# Stores in: backups/YYYY/MM/YYYY-MM-DD.sql.gz
# Run daily via cron: 0 6 * * * /home/mark/src/PenguinMonitor/backup.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

API_KEY="tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf"
DATE="${1:-$(date +%Y-%m-%d)}"
YEAR=$(echo "$DATE" | cut -d- -f1)
MONTH=$(echo "$DATE" | cut -d- -f2)

BACKUP_DIR="$SCRIPT_DIR/backups/$YEAR/$MONTH"
BACKUP_FILE="$BACKUP_DIR/$DATE.sql.gz"

if [ -f "$BACKUP_FILE" ]; then
    echo "Backup already exists: $BACKUP_FILE"
    exit 0
fi

mkdir -p "$BACKUP_DIR"

echo -n "Backing up $DATE..."
HTTP_CODE=$(curl -s -o "$BACKUP_FILE" -w "%{http_code}" \
    -H "X-API-Key: $API_KEY" \
    "https://wildwatch.co.nz/penguin-api/backup.php" \
    --max-time 120)

if [ "$HTTP_CODE" != "200" ]; then
    echo " FAILED (HTTP $HTTP_CODE)"
    cat "$BACKUP_FILE" 2>/dev/null
    rm -f "$BACKUP_FILE"
    exit 1
fi

SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null)
if [ "$SIZE" -lt 1000 ]; then
    echo " FAILED (file too small: ${SIZE} bytes)"
    cat "$BACKUP_FILE" 2>/dev/null
    rm -f "$BACKUP_FILE"
    exit 1
fi

echo " OK ($(numfmt --to=iec $SIZE 2>/dev/null || echo "${SIZE} bytes"))"
