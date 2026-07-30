#!/bin/bash
# Runs ON THE VPS from cron every 5 minutes. Asks the NAS three questions -- is it there, is
# its report fresh, did the last run actually restore -- and mails only when an answer
# changes. Between nightly runs nothing else asks: the check-in only proves the NAS was alive
# at 06:30, and nas-watchdog.sh is satisfied by ANY check-in, ok or fail, so a NAS that runs
# and fails every night keeps it quiet forever. This is the thing that notices.
#
# EDGE-TRIGGERED, all three: one email when an alarm goes off, one when it clears, nothing on
# the checks in between. A five-minute check that mailed every time would be a flood you'd
# learn to ignore, and one that only mailed on the way down would leave you wondering whether
# it ever recovered.
#
#   reach    the mirror's API answers through the Cloudflare tunnel at all
#   age      its last report is younger than STALE_H hours
#   restore  that report says the dump restored, verified, with rows in it
#
# Unreachable SUPPRESSES the other two: if the NAS cannot be asked, its report's age and
# verdict are unknown, and guessing would turn one outage into three emails. They resume --
# and fire if they should -- the moment it answers again.
#
#   nas-health.sh          check once; mail only on a change
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

STATE="${STATE:-/var/lib/nas-mirror}"
SECRETS="${SECRETS:-/var/www/wildwatch/shared/secrets.php}"
# Wider than the nightly alerts on purpose: a NAS that is off stays off until someone in the
# house walks past it, so the person who can go and look needs telling too.
export ALERT_TO="${ALERT_TO:-markhebberd@gmail.com, bdot@snotch.com}"
# Consecutive failed reachability checks before we call it down. At five minutes apart that is
# ~15 min of silence: long enough to ride out a reboot, a DSM update or a flapping tunnel,
# short enough that a real outage is still news the same hour. The other two alarms need no
# such patience -- they read a report that only changes once a night, so they cannot flap.
STRIKES="${STRIKES:-3}"
EVERY_MIN="${EVERY_MIN:-5}"          # the cron cadence, used only to word the emails
# The run is 06:30 NZ daily, so 24h means a night was missed. The extra hour is grace: a run
# that starts on time but takes a while, or a DST shift, should not mail. The admin page badges
# at 24h (MIRROR_STALE_SECONDS in App.tsx) -- a screen can afford to be twitchier than email.
STALE_H="${STALE_H:-25}"

mkdir -p "$STATE"
NOW=$(date -u +%s)

# "2 hours", "35 minutes" -- whatever unit still means something at that distance.
dur() {
  S=${1:-0}
  if   [ "$S" -lt 5400 ];   then echo "$(( (S + 30) / 60 )) minutes"
  elif [ "$S" -lt 172800 ]; then echo "$(( (S + 1800) / 3600 )) hours"
  else                           echo "$(( (S + 43200) / 86400 )) days"; fi
}

# ---- the edge, in one place ----------------------------------------------------------------
# No state file yet means "we have not seen this fail", not "we have never looked" -- so a NAS
# that is already broken when this is installed still alarms on its first bad answer.
alarm_state() { cat "$STATE/$1-state" 2>/dev/null || echo ok; }

# raise <key> <subject> <body> -- mails once, on the way into trouble.
raise() {
  [ "$(alarm_state "$1")" = bad ] && return 0
  printf 'bad\n'       > "$STATE/$1-state"
  printf '%s\n' "$NOW" > "$STATE/$1-since"
  nas-alert.sh "$2" "$3"
}

# all_clear <key> <subject> <body> -- mails once, on the way out, with how long it lasted.
all_clear() {
  [ "$(alarm_state "$1")" = bad ] || return 0
  SINCE=$(cat "$STATE/$1-since" 2>/dev/null || echo "$NOW")
  printf 'ok\n'        > "$STATE/$1-state"
  printf '%s\n' "$NOW" > "$STATE/$1-since"
  nas-alert.sh "$2" "$3 It had been that way for about $(dur $(( NOW - SINCE )))."
}

# ---- ask the NAS ---------------------------------------------------------------------------
# The mirror's address and key live in production's secrets.php, and PHP is the only thing that
# can be trusted to read PHP. Root cron can read the file; nothing here prints either value, and
# only the key ever leaves this box (as a header, over TLS, to the mirror).
secret() { php -r 'require $argv[1]; echo defined($argv[2]) ? constant($argv[2]) : "";' "$SECRETS" "$1" 2>/dev/null; }
URL=$(secret MIRROR_API_URL)
KEY=$(secret MIRROR_API_KEY)
if [ -z "$URL" ] || [ -z "$KEY" ]; then
  # Nothing to check is not the same as unhealthy, so this must not mail -- but it must not be
  # silent either, or a typo in secrets.php would quietly switch all three alarms off for good.
  logger -t nas-health "MIRROR_API_URL / MIRROR_API_KEY not readable from $SECRETS -- checked nothing"
  exit 0
fi

RESP=$(curl -s --connect-timeout 8 --max-time 20 -H "X-API-Key: $KEY" -H 'Accept: application/json' -w $'\n%{http_code}' "$URL")
RC=$?
CODE=${RESP##*$'\n'}
BODY=${RESP%$'\n'*}

# Reachable means the NAS itself answered. What it answered does not matter here -- even "401
# not your key" or "404 no run yet" is the machine talking, which is all this asks. Everything
# else is Cloudflare's edge apologising on its behalf, and each shape of apology means something
# different to whoever reads the email.
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

# ---- 1. is it there? -----------------------------------------------------------------------
if [ -n "$REASON" ]; then
  FAILS=$(( $(cat "$STATE/reach-fails" 2>/dev/null || echo 0) + 1 ))
  printf '%s\n' "$FAILS" > "$STATE/reach-fails"
  if [ "$FAILS" -ge "$STRIKES" ]; then
    raise reach "NAS is UNREACHABLE" \
      "The VPS cannot reach the NAS backup mirror: ${REASON}. It has failed $FAILS checks in a row, about $(dur $(( FAILS * EVERY_MIN * 60 ))), which is why this is being sent now rather than on the first miss. While the NAS is unreachable nothing is proving the offsite copy, and if the NAS is off it is not taking one either. There will be one more email when it comes back, and no others in between."
  fi
  # Its report's age and verdict are unknowable from here; say nothing about them.
  exit 0
fi
printf '0\n' > "$STATE/reach-fails"
all_clear reach "NAS is REACHABLE again" \
  "The VPS can reach the NAS backup mirror again. Nothing was done to it -- this is just the all-clear."

# The mirror answers 404 with JSON before its first run ever completes: reachable, but with no
# report to judge. Same for a reply carrying no age. Neither is a failure to shout about.
FIELDS=$(printf '%s' "$BODY" | php -r '
  $d = json_decode(stream_get_contents(STDIN), true);
  if (!is_array($d) || !isset($d["inventory_age_seconds"])) exit(1);
  // Sanitised on the way out: these values land in a shell string below.
  printf("%d %s %d %d",
    (int)$d["inventory_age_seconds"],
    preg_replace("/[^a-z]/", "", strtolower((string)($d["restore"] ?? ""))) ?: "unknown",
    (int)($d["rows_total"] ?? 0),
    (int)($d["tables"] ?? 0));
') || exit 0
read -r AGE RESTORE ROWS TABLES <<EOF
$FIELDS
EOF

# ---- 2. is its report fresh? ---------------------------------------------------------------
if [ "$AGE" -gt $(( STALE_H * 3600 )) ]; then
  raise age "NAS backup report is STALE (over ${STALE_H}h old)" \
    "The NAS is reachable, but its last backup report is $(dur "$AGE") old -- past the ${STALE_H} hour limit. The run is 06:30 NZ nightly, so a night has been missed: the NAS was off or asleep at 06:30, its cron did not fire, or the run died before it could write a report. Whatever that last report says, nothing has proved the offsite copy since then."
else
  all_clear age "NAS backup report is FRESH again" \
    "The NAS has published a backup report again -- the current one is $(dur "$AGE") old."
fi

# ---- 3. did it actually restore? -----------------------------------------------------------
# A dump that will not load is a file, not a backup. Zero rows counts as a failure in its own
# right even if the run called itself verified: an empty database restores perfectly.
if [ "$RESTORE" != verified ] || [ "$ROWS" -lt 1 ]; then
  raise restore "NAS restore FAILED (the offsite copy is not proven)" \
    "The NAS's last backup run did not restore and verify: restore=${RESTORE}, ${ROWS} rows across ${TABLES} tables. The dump it downloaded may still be fine, but nothing has shown that it loads -- and an untested backup is a hypothesis. The status page lists which step failed (download, restore, row counts, login). That report is $(dur "$AGE") old."
else
  all_clear restore "NAS restore is VERIFIED again" \
    "The NAS's latest run restored and verified: ${ROWS} rows across ${TABLES} tables."
fi
