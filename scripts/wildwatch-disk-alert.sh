#!/bin/bash
# External disk-space monitor for wildwatch.co.nz, run from an independent host (devian).
#
# Why external: the Asura shared host's PHP mail() is unreliable — the server-side
# disk_check.php "DISK FULL" alerts never arrived. Monitoring from devian and alerting
# via himalaya (Gmail SMTP) is reliable, and also catches the server being completely
# unreachable (disk so full it errors), which a server-side check never could.
#
# Cron (devian):
#   */15 * * * * /home/mark/src/PenguinMonitor/scripts/wildwatch-disk-alert.sh >> /tmp/wildwatch-disk-alert.log 2>&1
#
# Tuning / testing:
#   WW_DISK_THRESHOLD_GB=20   alert when server free space drops below this (GB)
#   WW_DISK_FORCE=1           send a test alert now, ignoring the throttle
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# API key lives in the git-ignored repo-root .env (not committed). Add it on each host that runs this cron.
[ -f "$SCRIPT_DIR/../.env" ] && . "$SCRIPT_DIR/../.env"
: "${API_KEY:?API_KEY not set — add it to the repo-root .env}"
THRESHOLD_GB="${WW_DISK_THRESHOLD_GB:-20}"     # normal free space is ~300-440 GB; 20 GB = real emergency
ALERT_TO="markhebberd@gmail.com,bdot@snotch.com"
THROTTLE_SECS=21600                            # at most one alert per 6h while a condition persists
STATE="/tmp/wildwatch-disk-alert.last"
HIMALAYA="$(command -v himalaya || echo "$HOME/.local/bin/himalaya")"
URL="https://wildwatch.co.nz/api/disk_history.php?cron=${API_KEY}"

now="$(date +%s)"
ts="$(date '+%Y-%m-%d %H:%M:%S %Z')"

send_alert() {  # $1 subject, $2 body, $3 state_file (optional) — throttled unless WW_DISK_FORCE=1
  local state_file="${3:-$STATE}"
  local last=0
  [ -f "$state_file" ] && last="$(cat "$state_file" 2>/dev/null || echo 0)"
  if [ "${WW_DISK_FORCE:-0}" != "1" ] && [ $((now - last)) -lt "$THROTTLE_SECS" ]; then
    echo "$ts  [throttled] $1"; return
  fi
  local ok=0
  for addr in $(echo "$ALERT_TO" | tr ',' ' '); do
    if printf 'To: %s\nSubject: %s\n\n%s\n' "$addr" "$1" "$2" | "$HIMALAYA" message send -a gmail >/dev/null 2>&1; then
      ok=1
    else
      echo "$ts  [alert SEND FAILED to $addr] $1"
    fi
  done
  if [ "$ok" = "1" ]; then
    echo "$now" > "$state_file"; echo "$ts  [alert sent] $1"
  fi
}

resp="$(curl -s --max-time 30 "$URL")"
free_mb="$(printf '%s' "$resp" | sed -n 's/.*"disk_free_mb":\([0-9][0-9]*\).*/\1/p')"

if [ -z "$free_mb" ]; then
  send_alert "WILDWATCH disk check FAILED to read free space" \
    "Could not read disk_free_mb from wildwatch.co.nz at $ts. The server may be down or its disk full. Response: ${resp:-<empty>}"
  exit 1
fi

free_gb=$((free_mb / 1024))
echo "$ts  ok: ${free_mb} MB (~${free_gb} GB) free"
if [ "$free_gb" -lt "$THRESHOLD_GB" ]; then
  send_alert "WILDWATCH server disk LOW: ~${free_gb} GB free" \
    "wildwatch.co.nz server free space is ${free_mb} MB (~${free_gb} GB), below the ${THRESHOLD_GB} GB threshold, at $ts. Likely the Asura shared-host disk filling again (see Asura ticket #045441)."
fi
