#!/bin/bash
# Runs ON THE VPS from cron every 5 minutes. Answers one question: can the NAS be reached
# right now? The nightly check-in only proves the NAS was alive at 06:30 -- between runs it
# could be powered off, unplugged or off the network for the best part of a day before
# anything said so. This watches the one inbound path the NAS has (its Cloudflare tunnel)
# and mails the moment the answer changes.
#
# EDGE-TRIGGERED, not level-triggered: it mails when the state CHANGES -- once when the NAS
# goes unreachable, once when it comes back -- and says nothing on every other check. A
# five-minute check that mailed every time would be a flood you'd learn to ignore, and one
# that only mailed on the way down would leave you wondering whether it ever recovered.
#
# This is deliberately NOT a backup check. It says nothing about whether the backup is good
# (nas-checkin.sh and nas-watchdog.sh do that) -- only whether the machine is there at all.
#
#   nas-reach.sh          check once; mail only if the state changed
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

STATE="${STATE:-/var/lib/nas-mirror}"
SECRETS="${SECRETS:-/var/www/wildwatch/shared/secrets.php}"
# Wider than the nightly alerts on purpose: a NAS that is off stays off until someone in the
# house walks past it, so the person who can go and look needs telling too.
export ALERT_TO="${ALERT_TO:-markhebberd@gmail.com, bdot@snotch.com}"
# Consecutive failed checks before we call it down. At five minutes apart that is ~15 min of
# silence: long enough to ride out a reboot, a DSM update or a flapping tunnel, short enough
# that a real outage is still news the same hour.
STRIKES="${STRIKES:-3}"
EVERY_MIN="${EVERY_MIN:-5}"          # the cron cadence, used only to word the emails

mkdir -p "$STATE"
# No state file yet means "we have not seen it fail", not "we have never looked" -- so a NAS
# that is already down when this is installed still alarms after STRIKES checks.
WAS=$(cat "$STATE/reach-state" 2>/dev/null || echo up)
FAILS=$(cat "$STATE/reach-fails" 2>/dev/null || echo 0)
SINCE=$(cat "$STATE/reach-since" 2>/dev/null || echo 0)
NOW=$(date -u +%s)

# "2 hours", "35 minutes" -- whatever unit still means something at that distance.
dur() {
  S=${1:-0}
  if   [ "$S" -lt 5400 ];  then echo "$(( (S + 30) / 60 )) minutes"
  elif [ "$S" -lt 172800 ]; then echo "$(( (S + 1800) / 3600 )) hours"
  else                          echo "$(( (S + 43200) / 86400 )) days"; fi
}

# The mirror's address and key live in production's secrets.php, and PHP is the only thing
# that can be trusted to read PHP. Root cron can read the file; nothing here prints either
# value, and only the key ever leaves this box (as a header, over TLS, to the mirror).
secret() { php -r 'require $argv[1]; echo defined($argv[2]) ? constant($argv[2]) : "";' "$SECRETS" "$1" 2>/dev/null; }
URL=$(secret MIRROR_API_URL)
KEY=$(secret MIRROR_API_KEY)
if [ -z "$URL" ] || [ -z "$KEY" ]; then
  # Nothing to check is not the same as unreachable, so this must not mail -- but it must not
  # be silent either, or a typo in secrets.php would quietly switch the alarm off for good.
  logger -t nas-reach "MIRROR_API_URL / MIRROR_API_KEY not readable from $SECRETS -- reachability check did nothing"
  exit 0
fi

RESP=$(curl -s --connect-timeout 8 --max-time 20 -H "X-API-Key: $KEY" -H 'Accept: application/json' -w $'\n%{http_code}' "$URL")
RC=$?
CODE=${RESP##*$'\n'}
BODY=${RESP%$'\n'*}

# Reachable means the NAS itself answered. What it answered does not matter here -- even
# "401 not your key" or "404 no run yet" is the machine talking, which is all this asks.
# Everything else is Cloudflare's edge apologising on the NAS's behalf, and each shape of
# apology means something different to whoever reads the email.
if [ "$RC" -ne 0 ]; then
  REASON="no answer at all from the tunnel (curl exit $RC) -- DNS, this server's link, or the tunnel hostname"
elif [ "${BODY#\{}" != "$BODY" ]; then
  REASON=""
elif printf '%s' "$BODY" | grep -qi cloudflareaccess; then
  REASON="Cloudflare Access turned this server away (HTTP $CODE). The NAS may well be fine -- the Access policy or the service token is what changed"
elif [ "$CODE" -ge 502 ] && [ "$CODE" -le 530 ]; then
  REASON="Cloudflare has no tunnel to the NAS (HTTP $CODE) -- the NAS is off, asleep, off the network, or its cloudflared container is not running"
else
  REASON="the mirror answered HTTP $CODE with something that is not JSON"
fi

if [ -z "$REASON" ]; then
  printf '0\n' > "$STATE/reach-fails"
  if [ "$WAS" = down ]; then
    printf 'up\n'    > "$STATE/reach-state"
    printf '%s\n' "$NOW" > "$STATE/reach-since"
    nas-alert.sh "NAS is REACHABLE again" \
      "The VPS can reach the NAS backup mirror again, after about $(dur $(( NOW - SINCE ))) unreachable. Nothing was done to it -- this is just the all-clear. If the outage crossed 06:30 NZ then a nightly backup+restore was probably missed; the status page and the next check-in will say."
  fi
  exit 0
fi

FAILS=$(( FAILS + 1 ))
printf '%s\n' "$FAILS" > "$STATE/reach-fails"
[ "$WAS" = down ] && exit 0                 # already said so; one email per outage
[ "$FAILS" -lt "$STRIKES" ] && exit 0       # a blip, not an outage -- wait for STRIKES in a row

printf 'down\n'      > "$STATE/reach-state"
printf '%s\n' "$NOW" > "$STATE/reach-since"
nas-alert.sh "NAS is UNREACHABLE" \
  "The VPS cannot reach the NAS backup mirror: ${REASON}. It has failed $FAILS checks in a row, about $(dur $(( FAILS * EVERY_MIN * 60 ))), which is why this is being sent now rather than on the first miss. While the NAS is unreachable nothing is proving the offsite copy, and if the NAS is off it is not taking one either. There will be one more email when it comes back, and no others in between."
