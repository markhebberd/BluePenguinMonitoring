#!/bin/bash
# One-shot NAS setup. Run ON the NAS as root, after nas-mirror/ has been rsynced to
# /volume1/wildwatch/nas-mirror and the app tree to /volume1/wildwatch/app.
#
#   WW_API_KEY='<production key>' /volume1/wildwatch/nas-mirror/bin/bootstrap-nas.sh
#
# Idempotent: existing passwords, keys and .env are left alone, so re-running after a
# half-finished attempt is safe (regenerating DB passwords would orphan the data volume).
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

WW_ROOT="${WW_ROOT:-/volume1/wildwatch}"
SRC="$WW_ROOT/nas-mirror"

command -v docker >/dev/null || { echo "docker not found — install Container Manager first" >&2; exit 1; }
[ -d "$SRC" ] || { echo "missing $SRC — rsync nas-mirror/ to the NAS first" >&2; exit 1; }
[ -f "$WW_ROOT/app/index.html" ] || { echo "missing $WW_ROOT/app/index.html — rsync the built SPA first" >&2; exit 1; }

rand() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }

mkdir -p "$WW_ROOT"/{app/api,shared,backups,kits,status,logs,bin,tmp,mac-kit,db}
chmod 700 "$WW_ROOT/shared" "$WW_ROOT/kits" "$WW_ROOT/db"

# ---- .env: container environment only (the entrypoint reads these on first run) ----
if [ ! -f "$SRC/.env" ]; then
  cat > "$SRC/.env" <<EOF
WW_DB_PASS=$(rand)
WW_DB_RO_PASS=$(rand)
EOF
  chmod 600 "$SRC/.env"
  echo "wrote $SRC/.env"
else
  echo "kept existing $SRC/.env"
fi
# shellcheck disable=SC1090
. "$SRC/.env"
DB_APP_PASS="$WW_DB_PASS"
DB_RO_PASS="$WW_DB_RO_PASS"

# ---- render docker-compose.yml with literal values ------------------------
# Container Manager's Project validator rejects ${VAR} interpolation, so the file it
# reads must contain no variables at all.
ADDR=$(ip -4 addr show 2>/dev/null | awk '/inet .*(eth|ovs_eth|bond)/ {sub(/\/.*/,"",$2); print $2; exit}' || true)
BIND="${BIND_ADDR:-${ADDR:-0.0.0.0}}"
PORT="${HTTP_PORT:-8080}"
sed -e "s|@@WW_ROOT@@|$WW_ROOT|g" -e "s|@@BIND_ADDR@@|$BIND|g" -e "s|@@HTTP_PORT@@|$PORT|g" \
    "$SRC/compose-template.yml" > "$SRC/docker-compose.yml"
chmod 644 "$SRC/docker-compose.yml"
echo "rendered docker-compose.yml (listening on $BIND:$PORT)"

# ---- secrets.php (local mirror credentials, not production's) -------------
if [ ! -f "$WW_ROOT/shared/secrets.php" ]; then
  sed -e "s/CHANGE_ME_MATCH_DB_APP_PASS/$DB_APP_PASS/" \
      -e "s/CHANGE_ME_MATCH_DB_RO_PASS/$DB_RO_PASS/" \
      -e "s/CHANGE_ME_LOCAL_ONLY_KEY/$(rand)/" \
      "$SRC/secrets.php.nas" > "$WW_ROOT/shared/secrets.php"
  chmod 640 "$WW_ROOT/shared/secrets.php"
  echo "wrote shared/secrets.php"
else
  echo "kept existing shared/secrets.php"
fi
ln -sfn /var/www/shared/secrets.php "$WW_ROOT/app/api/secrets.php"

# ---- production API key, for pulling the nightly dump ---------------------
if [ ! -f "$WW_ROOT/shared/nas.env" ]; then
  [ -n "${WW_API_KEY:-}" ] || { echo "set WW_API_KEY=<production key> and re-run" >&2; exit 1; }
  printf 'WW_API_KEY=%s\n' "$WW_API_KEY" > "$WW_ROOT/shared/nas.env"
  chmod 600 "$WW_ROOT/shared/nas.env"
  echo "wrote shared/nas.env"
fi

# ---- SSH key for fetching the rebuild kit from the VPS --------------------
if [ ! -f "$WW_ROOT/shared/id_nas" ]; then
  ssh-keygen -q -t ed25519 -N '' -C nas-rebuild-kit -f "$WW_ROOT/shared/id_nas"
  echo "generated shared/id_nas"
fi
chmod 600 "$WW_ROOT/shared/id_nas"

# ---- ownership: the container's web user (www-data = uid/gid 33 in Debian) must read
# secrets.php, but the SSH/API keys are used only by root's nightly job. Give the shared
# dir + secrets.php to group 33 (read via group, not world); keep the keys root-only so
# ssh accepts the private key.
chown root:33 "$WW_ROOT/shared" "$WW_ROOT/shared/secrets.php" 2>/dev/null || true
chmod 750 "$WW_ROOT/shared"; chmod 640 "$WW_ROOT/shared/secrets.php"
chown root:root "$WW_ROOT/shared/id_nas" "$WW_ROOT/shared/nas.env" 2>/dev/null || true

install -m 755 "$SRC/bin/nightly.sh" "$WW_ROOT/bin/nightly.sh"

# ---- image ----------------------------------------------------------------
# The compose file is image-only (DSM's Project wizard rejects `build:`), so build the
# image here once. Rebuild by hand only when the Dockerfile changes.
echo "building wildwatch-mirror:latest (first build pulls the base image — a few minutes)"
docker build -t wildwatch-mirror:latest "$SRC"

# ---- containers -----------------------------------------------------------
# START=0 prepares everything but leaves the container to Container Manager's Project UI,
# so the mirror shows up as one GUI object that can be stopped or deleted with a click.
if [ "${START:-1}" = 0 ]; then
  cat <<EOF

Prepared. Create it in the GUI:
  Container Manager -> Project -> Create
    Project name: wildwatch
    Path:         $SRC
    (it will find docker-compose.yml — choose "Use existing docker-compose.yml")

Site will be at: http://$BIND:$PORT/   (status at /status/)
EOF
  exit 0
fi

docker compose -f "$SRC/docker-compose.yml" up -d

printf 'waiting for the container'
for _ in $(seq 1 90); do
  if docker exec wildwatch mariadb -uroot -e "SELECT 1" >/dev/null 2>&1; then echo " — up"; break; fi
  printf '.'; sleep 2
done

cat <<EOF

Next, on the VPS, pin this key to the kit script (one line in /home/mark/.ssh/authorized_keys):

command="sudo /usr/local/bin/rebuild-kit.sh",restrict $(cat "$WW_ROOT/shared/id_nas.pub")

Then run the first nightly:  $WW_ROOT/bin/nightly.sh
Site will be at:             http://$BIND:$PORT/   (status at /status/)
EOF
