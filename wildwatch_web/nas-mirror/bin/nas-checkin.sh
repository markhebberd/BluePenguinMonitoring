#!/bin/bash
# Runs ON THE VPS, invoked by the NAS via the nas-fetch forced command at the end of every
# nightly run. Records the check-in time + outcome. On an explicit failure it emails right
# away; the "no check-in at all" case (NAS off, cron broken, network down) is caught
# separately by nas-watchdog.sh, which is the real dead-man's-switch.
#
#   nas-checkin.sh ok | fail
set -u
STATE=/var/lib/nas-mirror
mkdir -p "$STATE"
STATUS="${1:-unknown}"
date -u +%s > "$STATE/last-checkin"
printf '%s\n' "$STATUS" > "$STATE/last-status"

if [ "$STATUS" = fail ]; then
  /usr/local/bin/nas-alert.sh "restore FAILED on the NAS mirror" \
    "The nightly restore-and-verify on the NAS backup mirror reported a FAILURE tonight. Open the status page to see which step failed (download, restore, row counts, login, etc.)."
fi
