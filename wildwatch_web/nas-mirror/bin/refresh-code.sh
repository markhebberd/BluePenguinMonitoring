#!/bin/bash
# Pull production's deployed release and apply it to the mirror's app/ tree. This is the
# "Update live code to mirror" action, and the same thing the nightly does — factored out so
# the trigger-watcher can refresh code on demand without a full backup. Run as root on the NAS.
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

WW_ROOT="${WW_ROOT:-/volume1/docker/wildwatch}"
SHARED="$WW_ROOT/shared"
KIT_HOST="${KIT_HOST:-mark@wildwatch.co.nz}"
LOG="$WW_ROOT/logs/nightly.log"
TMP="$WW_ROOT/tmp"; mkdir -p "$TMP"
TGZ="$TMP/release.tar.gz"; REL="$TMP/release"

[ -f "$SHARED/id_nas" ] || { echo "refresh-code: no SSH key at shared/id_nas"; exit 1; }

if ! ssh -i "$SHARED/id_nas" -o BatchMode=yes -o ConnectTimeout=20 \
      -o StrictHostKeyChecking=accept-new "$KIT_HOST" release > "$TGZ" 2>>"$LOG" \
   || ! tar -tzf "$TGZ" >/dev/null 2>&1; then
  echo "refresh-code: release fetch from $KIT_HOST failed"; rm -f "$TGZ"; exit 1
fi

rm -rf "$REL"; mkdir -p "$REL"; tar -xzf "$TGZ" -C "$REL"
if [ -f "$REL/app/index.html" ] && ls "$REL"/app/api/*.php >/dev/null 2>&1; then
  # In-place (bind-mount safe); keep the secrets.php symlink; drop removed files.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude 'api/secrets.php' "$REL/app/" "$WW_ROOT/app/"
  else
    cp -a "$REL"/app/. "$WW_ROOT/app/"
  fi
  ln -sfn /var/www/shared/secrets.php "$WW_ROOT/app/api/secrets.php"
  REL_ID=$(tr -d '\n' < "$WW_ROOT/app/.release" 2>/dev/null)
  echo "refresh-code: app code refreshed to ${REL_ID:-ok}"
else
  echo "refresh-code: release payload incomplete"; rm -f "$TGZ"; rm -rf "$REL"; exit 1
fi
rm -f "$TGZ"; rm -rf "$REL"
