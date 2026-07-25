#!/bin/bash
# Runs ON THE VPS from cron, daily, a few hours after the NAS's 06:30 NZ run. This is the
# dead-man's-switch: it emails if the NAS has NOT checked in recently -- the one class of
# failure a NAS-side alert can never report, because a NAS that is off (or whose cron broke,
# or whose network is down) cannot send anything. If the check-ins stop, this shouts.
set -u
STATE=/var/lib/nas-mirror
NOW=$(date -u +%s)
LAST=$(cat "$STATE/last-checkin" 2>/dev/null || echo 0)
AGE_H=$(( (NOW - LAST) / 3600 ))

# Healthy check-in is only a few hours old at watchdog time; 20h means a whole day was
# missed. (NAS runs 06:30 NZ = ~17:30-18:30 UTC; watchdog runs 21:00 UTC.)
if [ "$LAST" = 0 ] || [ "$AGE_H" -ge 20 ]; then
  WHEN=$(date -u -d "@$LAST" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || echo never)
  /usr/local/bin/nas-alert.sh "NO CHECK-IN from the NAS mirror" \
    "The NAS backup mirror has not checked in for ${AGE_H}h (last check-in: ${WHEN}). Tonight's backup may not have run at all -- NAS powered off, the scheduled task broken, or the network down. The mirror only proves backups when it runs, so this needs a look."
fi
