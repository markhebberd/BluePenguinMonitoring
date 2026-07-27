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

  # Install any of OUR scripts the release carries a newer copy of — the same thing the
  # nightly does, so both paths leave the mirror in the same state. Without it, "Update live
  # code" refreshes the app but silently leaves the scripts stale.
  #
  # Refresh in place only (the release also carries the VPS-side scripts, which have no
  # business running here); never install one that fails to parse; and swap via a temp file
  # and mv, because this script or the nightly may itself be running and bash reads a script
  # as it executes. New copies take effect on the next invocation.
  if [ -d "$REL/bin" ] && ls "$REL"/bin/*.sh >/dev/null 2>&1; then
    UPD=""; BAD=""
    for S in "$REL"/bin/*.sh; do
      B=$(basename "$S")
      [ -f "$WW_ROOT/bin/$B" ] || continue
      if ! bash -n "$S" 2>>"$LOG"; then BAD="$BAD $B"; continue; fi
      cmp -s "$S" "$WW_ROOT/bin/$B" && continue
      if cp "$S" "$WW_ROOT/bin/.$B.new" && chmod 755 "$WW_ROOT/bin/.$B.new" \
         && mv -f "$WW_ROOT/bin/.$B.new" "$WW_ROOT/bin/$B"; then UPD="$UPD $B"
      else BAD="$BAD $B"; rm -f "$WW_ROOT/bin/.$B.new"; fi
    done
    [ -n "$UPD" ] && echo "refresh-code: scripts updated:$UPD (in effect next run)"
    [ -n "$BAD" ] && echo "refresh-code: kept on-disk copy of:$BAD (syntax or write failed)"
    [ -z "$UPD$BAD" ] && echo "refresh-code: scripts up to date"
  fi
else
  echo "refresh-code: release payload incomplete"; rm -f "$TGZ"; rm -rf "$REL"; exit 1
fi
rm -f "$TGZ"; rm -rf "$REL"
