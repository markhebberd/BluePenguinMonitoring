#!/bin/bash
# Wildwatch NAS mirror — nightly backup + restore-proof.
#
#   1. pull today's dump from wildwatch.co.nz            (outbound HTTPS only)
#   2. archive it forever under backups/YYYY/MM/         (never overwritten, never pruned)
#   3. wipe the INACTIVE slot (ww_a/ww_b) and restore into it from empty
#   4. verify the restore (tables, row counts, freshness, HTTP smoke test)
#   5. only then flip the live slot, so a bad night keeps serving the last good one
#   6. write status/index.html so anyone on the LAN can see it worked
#
# Run from DSM Task Scheduler as root, daily. Exit code is non-zero on failure so
# DSM's "send run details by email when the script terminates abnormally" fires.

set -u
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

WW_ROOT="${WW_ROOT:-/volume1/docker/wildwatch}"   # this deployment's root (override for tests)
BACKUP_URL="${BACKUP_URL:-https://wildwatch.co.nz/api/backup.php}"
KIT_HOST="${KIT_HOST:-mark@wildwatch.co.nz}"      # VPS: kit/release/checkin over SSH (defined early so finish() can check in even on an early failure)
DB_CT=wildwatch          # single container: MariaDB + Apache/PHP together

BACKUPS="$WW_ROOT/backups"
STATUS="$WW_ROOT/status"
SHARED="$WW_ROOT/shared"
LOG="$WW_ROOT/logs/nightly.log"

# WW_API_KEY (production read key) lives here, root-only.
# shellcheck disable=SC1090
[ -f "$SHARED/nas.env" ] && . "$SHARED/nas.env"

mkdir -p "$BACKUPS" "$STATUS" "$SHARED" "$WW_ROOT/kits" "$WW_ROOT/tmp" "$(dirname "$LOG")"

# Serialise runs: a manual "Back up now" (trigger-watcher) and the 06:30 cron must never
# overlap -- both drop/recreate the ww_a/ww_b slots. Skip this run if another holds the lock.
exec 9>"$WW_ROOT/tmp/nightly.lock" || true
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || { echo "another nightly run is in progress -- skipping"; exit 0; }
fi

DATE=$(date +%Y-%m-%d)
STAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
YEAR=${DATE%%-*}
MONTH=$(echo "$DATE" | cut -d- -f2)
DEST_DIR="$BACKUPS/$YEAR/$MONTH"
DEST="$DEST_DIR/$DATE.sql.gz"
TMP="$WW_ROOT/tmp"; mkdir -p "$TMP"
WORK="$TMP/$DATE.sql.gz.part"

STEPS=""          # accumulated "ok|warn|fail<TAB>label<TAB>detail" lines for the status page
FAILED=0          # only a hard 'fail' flips the badge to RESTORE FAILED

say()  { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
# 'warn' shows a caution row but does NOT fail the night — used for things that leave the
# mirror degraded-but-serving (e.g. the app-code refresh couldn't reach the VPS).
step() { STEPS="${STEPS}$1	$2	$3
"; [ "$1" = fail ] && FAILED=1; }

# Run a query as root inside the container. root authenticates via unix_socket, so
# there is no password to pass around or leak into a process list.
dbq() {
  docker exec -i "$DB_CT" sh -c "exec mariadb -uroot -N -B $1" 2>>"$LOG"
}

# Month length without depending on `date` (DSM's date is busybox-limited).
dim() { case "$2" in 01|03|05|07|08|10|12) echo 31;; 04|06|09|11) echo 30;;
  02) local y=$1; if [ $((y%4)) -eq 0 ] && { [ $((y%100)) -ne 0 ] || [ $((y%400)) -eq 0 ]; }; then echo 29; else echo 28; fi;; esac; }
mon_name() { case "$((10#$1))" in 1)echo Jan;;2)echo Feb;;3)echo Mar;;4)echo Apr;;5)echo May;;6)echo Jun;;7)echo Jul;;8)echo Aug;;9)echo Sep;;10)echo Oct;;11)echo Nov;;12)echo Dec;;esac; }

# A calendar of every archived backup: one row per month, a green cell for each day that
# has a restore-tested dump, a dim cell for days with none (so the NAS being off shows as
# a visible gap). This is what tells Britta at a glance how many good backups are here.
render_calendar() {
  local dates set count oldest newest y m ey em d cell tip dcount
  dates=$(find "$BACKUPS" -name '*.sql.gz' 2>/dev/null \
          | sed -E 's#.*/([0-9]{4}-[0-9]{2}-[0-9]{2})\.sql\.gz#\1#' | sort -u)
  [ -n "$dates" ] || return
  set=" $(echo $dates | tr '\n' ' ') "
  count=$(printf '%s\n' "$dates" | grep -c .)
  oldest=$(printf '%s\n' "$dates" | head -1)
  newest=$(printf '%s\n' "$dates" | tail -1)

  printf '<div class=summary><div class=big>%s</div><div>nightly backups on this NAS, ' "$count"
  printf 'every one restore-tested</div><div class=m>%s &rarr; %s &middot; none ever deleted</div></div>' \
    "$oldest" "$newest"

  # Don't draw future days of the current month as empty "off" cells — cap at today so the
  # only dim cells are real gaps (the NAS being off), which is what the legend claims.
  local mm last ty tm td
  ty=${DATE%%-*}; tm=$((10#$(printf '%s' "${DATE:-0000-00-00}" | cut -d- -f2))); td=$((10#$(printf '%s' "${DATE:-00-00-00}" | cut -d- -f3)))
  printf '<div class=cal>'
  y=${oldest%%-*}; m=$((10#$(printf '%s' "$oldest" | cut -d- -f2)))
  ey=${newest%%-*}; em=$((10#$(printf '%s' "$newest" | cut -d- -f2)))
  while [ $((y*12 + m)) -le $((ey*12 + em)) ]; do
    mm=$(printf '%02d' "$m")
    last=$(dim "$y" "$mm")
    [ "$y" = "$ty" ] && [ "$m" -eq "$tm" ] && last=$td   # current month: stop at today
    printf '<div class=mrow><span class=ml>%s %s</span><span class=days>' "$(mon_name "$mm")" "$y"
    dcount=0
    for d in $(seq 1 "$last"); do
      tip=$(printf '%04d-%02d-%02d' "$y" "$m" "$d")
      case "$set" in *" $tip "*) cell=on; dcount=$((dcount+1));; *) cell=off;; esac
      printf '<i class=%s title="%s"></i>' "$cell" "$tip"
    done
    printf '</span><span class=mc>%s</span></div>' "$dcount"
    m=$((m+1)); [ "$m" -gt 12 ] && { m=1; y=$((y+1)); }
  done
  printf '</div>'
}

write_status() {
  local badge="RESTORE VERIFIED" cls=ok sub="Last night&rsquo;s backup was restored into an empty database and checked."
  [ "$FAILED" -ne 0 ] && { badge="RESTORE FAILED"; cls=bad; sub="Last night&rsquo;s check did not pass &mdash; see the steps below."; }
  {
    printf '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
    printf '<title>Wildwatch backup status</title><style>'
    printf 'body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:1.25rem;background:#fff;color:#2a2a2a}'
    printf '.card{max-width:46rem;margin:auto}h1{font-size:1.2rem;margin:0 0 .25rem;color:#1a3a4a}h2{font-size:1rem;margin:1.5rem 0 .25rem;color:#1a3a4a}'
    printf '.badge{display:inline-block;padding:.35rem .8rem;border-radius:999px;font-weight:600;letter-spacing:.02em}'
    printf '.ok{background:#e6f4ea;color:#1e7e34}.bad{background:#fdecea;color:#c0392b}'
    printf '.summary{margin:1.25rem 0;padding:1.1rem 1.25rem;background:#f5f8fa;border:1px solid #e2e8ee;border-radius:12px}'
    printf '.summary .big{font-size:2.4rem;font-weight:700;line-height:1;color:#1a6b8f}'
    printf '.cal{margin:.75rem 0 .25rem}.mrow{display:flex;align-items:center;gap:.6rem;margin:2px 0}'
    printf '.ml{width:4.5rem;color:#666;font-size:.8rem;text-align:right;flex:none}'
    printf '.days{display:flex;flex-wrap:wrap;gap:2px;flex:1}.mc{width:1.6rem;color:#666;font-size:.8rem;text-align:right}'
    printf '.days i{width:12px;height:12px;border-radius:2px;background:#e2e8ee}'
    printf '.days i.on{background:#2e9e4f}.days i.off{background:#e2e8ee}'
    printf 'table{border-collapse:collapse;width:100%%;margin-top:.5rem}'
    printf 'td{padding:.45rem .6rem;border-top:1px solid #e5e9ee;vertical-align:top}'
    printf 'td.s{width:1.6rem}.m{color:#666;font-size:.9rem}a{color:#1a6b8f}.leg{font-size:.8rem;color:#666;margin-top:.4rem}'
    printf '.leg i{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px}</style>'
    printf '<div class=card><h1>Wildwatch backup mirror</h1>'
    printf '<p><span class="badge %s">%s</span></p><p class=m>%s Checked %s.</p>' "$cls" "$badge" "$sub" "$STAMP"

    render_calendar
    printf '<p class=leg><i style="background:#2e9e4f"></i> a day with a restore-tested backup &nbsp; '
    printf '<i style="background:#e2e8ee"></i> no backup that day (NAS was off)</p>'

    printf '<h2>Last night&rsquo;s check</h2><table>'
    printf '%s' "$STEPS" | while IFS='	' read -r st label detail; do
      [ -z "$label" ] && continue
      case "$st" in
        ok)   icon='<span style="color:#1e7e34">&#10003;</span>' ;;
        warn) icon='<span style="color:#b8860b">&#9888;</span>'  ;;
        *)    icon='<span style="color:#c0392b">&#10007;</span>' ;;
      esac
      printf '<tr><td class=s>%s</td><td>%s</td><td class=m>%s</td></tr>' "$icon" "$label" "$detail"
    done
    printf '</table>'
    printf '<p class=m>%s on disk in total, covering the database, the source code and the server '
    printf 'rebuild kit &mdash; this NAS is a complete third copy of Wildwatch.</p>' "${TOTAL:-?}"
    printf '<p><a href="/">Open the restored copy of Wildwatch &rarr;</a></p>'
    printf '<p class=m>The site above is rebuilt from the newest backup every night, so any '
    printf 'edits made there disappear. The real data lives at wildwatch.co.nz.</p></div>'
  } > "$STATUS/index.html.new" && mv "$STATUS/index.html.new" "$STATUS/index.html"
  chmod 644 "$STATUS/index.html"
}

finish() {
  write_status
  # Check in with the VPS dead-man's-switch: 'ok' on a clean night, 'fail' otherwise. A
  # missing check-in (this SSH never lands, or the whole run never happened) is what the
  # VPS watchdog alerts on. Never let a check-in failure change the run's own exit status.
  if [ -f "$SHARED/id_nas" ]; then
    if [ "$FAILED" -eq 0 ]; then CK=ok; else CK=fail; fi
    ssh -i "$SHARED/id_nas" -o BatchMode=yes -o ConnectTimeout=20 \
      -o StrictHostKeyChecking=accept-new "$KIT_HOST" "checkin $CK" >/dev/null 2>>"$LOG" || true
  fi
  if [ "$FAILED" -ne 0 ]; then say "FAILED — see $LOG"; exit 1; fi
  say "OK"; exit 0
}

# ---------------------------------------------------------------- 1. download
say "=== $STAMP ==="
if [ -f "$DEST" ]; then
  say "already have $DEST — re-verifying restore from it"
  cp "$DEST" "$WORK"
  step ok "Download" "already had $DATE.sql.gz"
else
  if [ -z "${WW_API_KEY:-}" ]; then
    step fail "Download" "WW_API_KEY missing from shared/nas.env"
    finish
  fi
  CODE=$(curl -sS -o "$WORK" -w '%{http_code}' --max-time 300 \
           -H "X-API-Key: $WW_API_KEY" "$BACKUP_URL" 2>>"$LOG")
  SIZE=$(wc -c < "$WORK" 2>/dev/null || echo 0)
  if [ "$CODE" != "200" ] || [ "$SIZE" -lt 100000 ] || ! gzip -t "$WORK" 2>/dev/null; then
    step fail "Download" "HTTP $CODE, ${SIZE} bytes, gzip check failed"
    rm -f "$WORK"; finish
  fi
  step ok "Download" "HTTP 200, $((SIZE / 1024)) KB gzipped"
fi

# Sanity: it must look like our schema, not an error page that happened to gzip.
if ! gzip -cd "$WORK" | grep -q 'CREATE TABLE `observations`'; then
  step fail "Dump contents" "no observations table in the dump"
  rm -f "$WORK"; finish
fi

# ---------------------------------------------------------------- 2. archive
if [ ! -f "$DEST" ]; then
  mkdir -p "$DEST_DIR"
  mv "$WORK" "$DEST" && chmod 440 "$DEST"
  step ok "Archive" "$DEST"
else
  rm -f "$WORK"
  step ok "Archive" "$DEST (kept)"
fi
KEPT=$(find "$BACKUPS" -name '*.sql.gz' | wc -l | tr -d ' ')
TOTAL=$(du -sh "$WW_ROOT" 2>/dev/null | cut -f1)

# ------------------------------------------- 2b. source code (public GitHub repo)
# DSM has no git by default; use it if the Git Server package is installed, else run
# git in a throwaway container — Container Manager is already a requirement here.
# safe.directory: the mirror is root-owned and git refuses to touch a repo owned by
# another uid, which is exactly what a container sees on a bind mount.
if command -v git >/dev/null 2>&1; then
  gitm() { git -c safe.directory='*' -C "$MIRROR" "$@"; }
  gitclone() { git clone --quiet --mirror "$REPO_URL" "$MIRROR"; }
else
  gitm() { docker run --rm -v "$WW_ROOT:/w" alpine/git -c safe.directory='*' -C /w/repo.git "$@"; }
  gitclone() { docker run --rm -v "$WW_ROOT:/w" alpine/git clone --quiet --mirror "$REPO_URL" /w/repo.git; }
fi

MIRROR="$WW_ROOT/repo.git"
REPO_URL="${REPO_URL:-https://github.com/markhebberd/PenguinMonitor.git}"
if [ -d "$MIRROR" ]; then
  gitm remote update --prune >>"$LOG" 2>&1 || true
else
  gitclone >>"$LOG" 2>&1 || true
fi
REPO_SHA=$(gitm rev-parse --short refs/heads/main 2>/dev/null | tr -d '\r')
REPO_WHEN=$(gitm log -1 --format=%cs refs/heads/main 2>/dev/null | tr -d '\r')
if [ -n "$REPO_SHA" ]; then
  step ok "Source code" "mirrored to $REPO_SHA (last commit $REPO_WHEN)"
else
  step fail "Source code" "git mirror of $REPO_URL failed — see $LOG"
fi

# --------------------------------- 2c. rebuild kit (secrets + server config)
# Everything a rebuild needs that is neither in the dump nor in the public repo.
KITS="$WW_ROOT/kits/$YEAR/$MONTH"
KIT="$KITS/$DATE.tar.gz"
KIT_HOST="${KIT_HOST:-mark@wildwatch.co.nz}"
KIT_KEEP="${KIT_KEEP:-0}"     # 0 = keep forever. Set to 7 if you fetch Maildirs too.
if [ -f "$KIT" ]; then
  step ok "Rebuild kit" "already had $DATE.tar.gz"
elif [ ! -f "$SHARED/id_nas" ]; then
  step fail "Rebuild kit" "no SSH key at shared/id_nas — see README step 6"
else
  mkdir -p "$KITS"
  if ssh -i "$SHARED/id_nas" -o BatchMode=yes -o ConnectTimeout=20 \
        -o StrictHostKeyChecking=accept-new "$KIT_HOST" kit > "$KIT.part" 2>>"$LOG" \
     && tar -tzf "$KIT.part" >/dev/null 2>&1 \
     && [ "$(wc -c < "$KIT.part")" -gt 2000 ]; then
    mv "$KIT.part" "$KIT"; chmod 400 "$KIT"
    step ok "Rebuild kit" "$(( $(wc -c < "$KIT") / 1024 )) KB — secrets, nginx, mail, DKIM, DNS"
  else
    rm -f "$KIT.part"
    step fail "Rebuild kit" "fetch from $KIT_HOST failed — see $LOG"
  fi
  if [ "$KIT_KEEP" -gt 0 ]; then
    find "$WW_ROOT/kits" -name '*.tar.gz' | sort | head -n -"$KIT_KEEP" | xargs -r rm -f
  fi
fi

# ------------------------------------------------- 3. restore into empty slot
if ! docker exec "$DB_CT" true 2>>"$LOG"; then
  step fail "Database" "container $DB_CT is not running"
  finish
fi

ACTIVE=$(cat "$SHARED/active_db" 2>/dev/null | tr -d '[:space:]')
[ "$ACTIVE" = "ww_a" ] || [ "$ACTIVE" = "ww_b" ] || ACTIVE=ww_b   # so the first run targets ww_a
if [ "$ACTIVE" = "ww_a" ]; then TARGET=ww_b; else TARGET=ww_a; fi
say "restoring into $TARGET (live slot is $ACTIVE)"

dbq "-e \"DROP DATABASE IF EXISTS $TARGET; CREATE DATABASE $TARGET CHARACTER SET utf8mb4;\"" >/dev/null
if [ "$(dbq "-e \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TARGET';\"")" != "0" ]; then
  step fail "Wipe slot" "$TARGET not empty before restore"
  finish
fi

T0=$(date +%s)
if ! gzip -cd "$DEST" | docker exec -i "$DB_CT" sh -c "exec mariadb -uroot $TARGET" 2>>"$LOG"; then
  step fail "Restore" "mariadb rejected the dump — see $LOG"
  finish
fi
SECS=$(( $(date +%s) - T0 ))
step ok "Restore" "loaded into empty $TARGET in ${SECS}s"

# ---------------------------------------------------------------- 4. verify
TABLES=$(dbq "-e \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TARGET';\"")
if [ "${TABLES:-0}" -lt 12 ]; then
  step fail "Tables" "only ${TABLES:-0} tables restored (expected 12+)"
  finish
fi
step ok "Tables" "$TABLES tables"

COUNTS=""
COUNT_FAIL=0
# Every base table in the restored slot, DISCOVERED rather than listed. A table added,
# renamed or dropped in production is picked up on the next run with no edit here — which
# is the point: a hardcoded list turns a schema change into a silent nightly abort.
TABLE_NAMES=$(dbq "-N -B -e \"SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema='$TARGET' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;\"")
TBL_SEEN=0; ROWS_TOTAL=0; PREV_TOTAL=0
for T in $TABLE_NAMES; do
  N=$(dbq "-D $TARGET -e \"SELECT COUNT(*) FROM \\\`$T\\\`;\"")
  N=${N:-0}
  PREV=$(grep "^$T	" "$STATUS/last-counts.tsv" 2>/dev/null | cut -f2)
  PREV=${PREV:-0}
  COUNTS="${COUNTS}$T	$N
"
  TBL_SEEN=$(( TBL_SEEN + 1 )); ROWS_TOTAL=$(( ROWS_TOTAL + N )); PREV_TOTAL=$(( PREV_TOTAL + PREV ))
  # Judge each table against ITSELF last night. A table that is new, renamed-into, or simply
  # empty has PREV=0 and just gets a baseline — only losing rows is suspicious.
  #
  # A shrink is a WARNING, not a failure, because plenty of tables shrink honestly: sessions
  # expire, password_resets are consumed, disk_history is pruned, a dismissal is withdrawn.
  # Failing on those would cry wolf nightly and train everyone to ignore the badge. The one
  # case still worth failing on its own is a substantial table emptied outright.
  if [ "$PREV" -ge 500 ] && [ "$N" -eq 0 ]; then
    step fail "Rows: $T" "0 rows, was $PREV last night"; COUNT_FAIL=1
  elif [ "$PREV" -gt 0 ] && [ "$N" -lt $(( PREV * 95 / 100 )) ]; then
    step warn "Rows: $T" "$N rows, down from $PREV last night"
  fi
done
if [ "$TBL_SEEN" -eq 0 ]; then
  step fail "Rows" "no base tables found in $TARGET"; COUNT_FAIL=1
elif [ "$PREV_TOTAL" -gt 0 ] && [ "$ROWS_TOTAL" -lt $(( PREV_TOTAL * 95 / 100 )) ]; then
  # This is the truncated-dump signal, and it needs no table names to spot: the database as
  # a whole does not lose 5% of its rows overnight.
  step fail "Rows" "$ROWS_TOTAL rows across $TBL_SEEN tables, down from $PREV_TOTAL last night"; COUNT_FAIL=1
else
  # One summary line rather than a row per table — the list is schema-length now, and anything
  # that moved the wrong way has already said so above.
  step ok "Rows" "$TBL_SEEN tables, $ROWS_TOTAL rows$( [ "$PREV_TOTAL" -gt 0 ] && echo " (was $PREV_TOTAL)")"
fi

# The dump should contain recent fieldwork, not a stale snapshot served from cache.
LATEST=$(dbq "-D $TARGET -e \"SELECT COALESCE(DATE(MAX(observation_time_utc)),'') FROM observations;\"")
AGE_DAYS=$(dbq "-D $TARGET -e \"SELECT COALESCE(DATEDIFF(CURDATE(), MAX(observation_time_utc)), 9999) FROM observations;\"")
step ok "Latest observation" "${LATEST:-none} (${AGE_DAYS} days ago)"

[ "$COUNT_FAIL" -eq 0 ] || finish

# ------------------------------------------------------------------- 5. flip
printf '%s' "$TARGET" > "$SHARED/active_db.new" && mv "$SHARED/active_db.new" "$SHARED/active_db"
printf '%s' "$COUNTS" > "$STATUS/last-counts.tsv"
step ok "Go live" "serving $TARGET"

# Refresh the running app from production's deployed release. The dump already carries
# the schema; this makes the SPA + PHP track production too, so nothing on a dev machine
# ever has to feed the mirror. A fetch failure is a warning, not a failure: the mirror
# keeps serving the app code already on disk, and the restore is what the badge certifies.
REL_TGZ="$TMP/release.tar.gz"; REL_TMP="$TMP/release"
if [ ! -f "$SHARED/id_nas" ]; then
  step warn "App code" "no SSH key at shared/id_nas — serving on-disk copy"
elif ssh -i "$SHARED/id_nas" -o BatchMode=yes -o ConnectTimeout=20 \
       -o StrictHostKeyChecking=accept-new "$KIT_HOST" release > "$REL_TGZ" 2>>"$LOG" \
     && tar -tzf "$REL_TGZ" >/dev/null 2>&1; then
  rm -rf "$REL_TMP"; mkdir -p "$REL_TMP"; tar -xzf "$REL_TGZ" -C "$REL_TMP"
  if [ -f "$REL_TMP/app/index.html" ] && ls "$REL_TMP"/app/api/*.php >/dev/null 2>&1; then
    # Update in place (bind-mount safe); keep the secrets.php symlink; drop removed files.
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete --exclude 'api/secrets.php' "$REL_TMP/app/" "$WW_ROOT/app/" 2>>"$LOG"
    else
      cp -a "$REL_TMP"/app/. "$WW_ROOT/app/"
    fi
    ln -sfn /var/www/shared/secrets.php "$WW_ROOT/app/api/secrets.php"
    REL_ID=$(tr -d '\n' < "$WW_ROOT/app/.release" 2>/dev/null)
    step ok "App code" "${REL_ID:-refreshed} (pulled from production release)"
  else
    step warn "App code" "release payload incomplete — serving on-disk copy"
  fi
else
  step warn "App code" "release fetch from $KIT_HOST failed — serving on-disk copy"
fi
rm -f "$REL_TGZ"; rm -rf "$REL_TMP"

# Probe from inside the container (Apache on :80) rather than a host address — the
# published port is bound to a specific LAN IP, so 127.0.0.1 on the host doesn't answer.
SPA=$(docker exec "$DB_CT" curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://127.0.0.1/ || echo 000)
API=$(docker exec "$DB_CT" curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://127.0.0.1/api/snapshot.php || echo 000)
# 401 is the healthy answer from the API: it is up and demanding a login.
if [ "$SPA" = "200" ] && [ "$API" = "401" ]; then
  step ok "Site" "app 200, API 401 (auth required)"
else
  step fail "Site" "app $SPA, API $API"
fi

# Full auth round-trip — log in, then use the token on a SECOND request. A plain login
# check isn't enough: tonight a missing DB grant crashed login, and separately Apache
# stripped the Authorization header so a minted token was rejected on the next call —
# both would pass a "does login return JSON" test. This creates a throwaway account in
# the live slot, logs in, calls action=me with the token, and requires the account back.
SMK_EMAIL='__nightly_smoke__@local'
SMK_HASH=$(docker exec "$DB_CT" php -r 'echo password_hash("nightly-smoke", PASSWORD_BCRYPT);' 2>>"$LOG")
AUTH_OK=0; AUTH_WHY="setup failed"
# The account table is discovered from the foreign key sessions already carries, and its
# columns from information_schema, so a rename (observers -> users, observer_name -> f_name)
# or a new NOT NULL column needs no edit here.
UTBL=$(dbq "-N -B -e \"SELECT REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$TARGET' AND TABLE_NAME='sessions' AND REFERENCED_TABLE_NAME IS NOT NULL LIMIT 1;\"" | tr -d '[:space:]')
UPK=$(dbq "-N -B -e \"SELECT REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='$TARGET' AND TABLE_NAME='sessions' AND REFERENCED_TABLE_NAME IS NOT NULL LIMIT 1;\"" | tr -d '[:space:]')
ucol() {  # first column of $UTBL whose name matches $1, or empty
  dbq "-N -B -e \"SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE table_schema='$TARGET' AND table_name='$UTBL' AND COLUMN_NAME LIKE '$1' ORDER BY ORDINAL_POSITION LIMIT 1;\"" | tr -d '[:space:]'
}
UEMAIL=$(ucol '%email%'); UHASH=$(ucol '%pass%')
if [ -z "$UTBL" ] || [ -z "$UPK" ] || [ -z "$UEMAIL" ] || [ -z "$UHASH" ]; then
  SMK_HASH=""; AUTH_WHY="could not locate the account table via the sessions foreign key"
fi
if [ -n "$SMK_HASH" ]; then
  # Every other column that must be supplied: NOT NULL, no default, not auto-increment.
  # Numeric ones get 0 and everything else a label, so a column added upstream cannot break
  # the insert. Read as tab-separated name/type pairs.
  UCOLS="$UEMAIL,$UHASH"; UVALS="'$SMK_EMAIL','$SMK_HASH'"
  REQ_COLS=$(dbq "-N -B -e \"SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE table_schema='$TARGET' AND table_name='$UTBL' AND IS_NULLABLE='NO' AND COLUMN_DEFAULT IS NULL AND EXTRA NOT LIKE '%auto_increment%' AND COLUMN_NAME NOT IN ('$UEMAIL','$UHASH') AND COLUMN_NAME <> '$UPK';\"")
  OLDIFS=$IFS; IFS='
'
  for LINE in $REQ_COLS; do
    CN=$(printf '%s' "$LINE" | cut -f1); CT=$(printf '%s' "$LINE" | cut -f2)
    [ -n "$CN" ] || continue
    case "$CT" in int|bigint|smallint|tinyint|decimal|float|double) CV="0" ;; *) CV="'Nightly Smoke'" ;; esac
    UCOLS="$UCOLS,$CN"; UVALS="$UVALS,$CV"
  done
  IFS=$OLDIFS
  docker exec "$DB_CT" mariadb -uroot -e "INSERT INTO $TARGET.$UTBL ($UCOLS) VALUES ($UVALS);" 2>>"$LOG"
  SMK_OID=$(docker exec "$DB_CT" mariadb -uroot -N -B -e "SELECT $UPK FROM $TARGET.$UTBL WHERE $UEMAIL='$SMK_EMAIL';" 2>>"$LOG")
  TOK=$(docker exec "$DB_CT" curl -s --max-time 20 -X POST 'http://127.0.0.1/api/crud.php?action=login' \
        -H 'Content-Type: application/json' -d "{\"email\":\"$SMK_EMAIL\",\"password\":\"nightly-smoke\"}" \
        2>/dev/null | sed -n 's/.*"token":"\([a-f0-9]*\)".*/\1/p')
  if [ -z "$TOK" ]; then
    AUTH_WHY="login returned no token (DB grant / PHP error?)"
  else
    ME=$(docker exec "$DB_CT" curl -s --max-time 20 -H "Authorization: Bearer $TOK" 'http://127.0.0.1/api/crud.php?action=me' 2>/dev/null)
    case "$ME" in
      *'Nightly Smoke'*) AUTH_OK=1 ;;
      *) AUTH_WHY="token rejected on next request (Authorization header stripped?)" ;;
    esac
  fi
  [ -n "${SMK_OID:-}" ] && docker exec "$DB_CT" mariadb -uroot -e "DELETE FROM $TARGET.sessions WHERE observer_id=$SMK_OID; DELETE FROM $TARGET.$UTBL WHERE $UPK=$SMK_OID;" 2>>"$LOG"
fi
if [ "$AUTH_OK" = 1 ]; then
  step ok "Login" "logged in and the token was accepted on the next request"
else
  step fail "Login" "$AUTH_WHY"
fi

finish
