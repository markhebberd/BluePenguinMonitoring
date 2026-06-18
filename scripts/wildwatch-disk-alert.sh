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

API_KEY="tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf"
THRESHOLD_GB="${WW_DISK_THRESHOLD_GB:-20}"     # normal free space is ~300-440 GB; 20 GB = real emergency
ALERT_TO="markhebberd@gmail.com"
THROTTLE_SECS=21600                            # at most one alert per 6h while a condition persists
STATE="/tmp/wildwatch-disk-alert.last"
HIMALAYA="$(command -v himalaya || echo "$HOME/.local/bin/himalaya")"
URL="https://wildwatch.co.nz/api/disk_history.php?cron=${API_KEY}"

now="$(date +%s)"
ts="$(date '+%Y-%m-%d %H:%M:%S %Z')"

send_alert() {  # $1 subject, $2 body — throttled unless WW_DISK_FORCE=1
  local last=0
  [ -f "$STATE" ] && last="$(cat "$STATE" 2>/dev/null || echo 0)"
  if [ "${WW_DISK_FORCE:-0}" != "1" ] && [ $((now - last)) -lt "$THROTTLE_SECS" ]; then
    echo "$ts  [throttled] $1"; return
  fi
  if printf 'To: %s\nSubject: %s\n\n%s\n' "$ALERT_TO" "$1" "$2" | "$HIMALAYA" message send -a gmail >/dev/null 2>&1; then
    echo "$now" > "$STATE"; echo "$ts  [alert sent] $1"
  else
    echo "$ts  [alert SEND FAILED] $1"
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
