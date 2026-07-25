#!/bin/bash
# Host-side watcher, run every minute by cron (root). Executes the on-demand mirror actions
# the web UI requests via flag files in triggers/. The web container can only DROP a flag
# (its one writable mount); ONLY this root script acts, and only ever runs the two fixed
# scripts below -- so even a fully compromised, public web app can at worst re-queue a
# backup or a code refresh, never run arbitrary commands on the NAS.
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

WW_ROOT="${WW_ROOT:-/volume1/docker/wildwatch}"
T="$WW_ROOT/triggers"
LOG="$WW_ROOT/logs/trigger.log"
[ -d "$T" ] || exit 0
mkdir -p "$(dirname "$LOG")"

if [ -f "$T/release.req" ]; then
  rm -f "$T/release.req"
  echo "[$(date '+%F %T')] release requested" >> "$LOG"
  WW_ROOT="$WW_ROOT" "$WW_ROOT/bin/refresh-code.sh" >> "$LOG" 2>&1
fi

if [ -f "$T/backup.req" ]; then
  rm -f "$T/backup.req"
  echo "[$(date '+%F %T')] backup requested" >> "$LOG"
  WW_ROOT="$WW_ROOT" "$WW_ROOT/bin/nightly.sh" >> "$LOG" 2>&1
fi
