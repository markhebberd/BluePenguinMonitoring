#!/usr/bin/env bash
# Pull-and-build deploy for wildwatch. Runs on the VPS (triggered by GitHub Actions).
# git pull -> npm build -> assemble atomic release -> chown -> flip -> smoke test -> rollback.
#
# Canonical copy. The live script lives at /var/www/wildwatch/deploy.sh on the VPS
# (invoked via the CI forced-command SSH key). Keep the two in sync when editing.
set -euo pipefail
BASE=/var/www/wildwatch
REPO="$BASE/repo"
APP="$REPO/wildwatch_web"

echo "[1/5] pull latest origin/main"
cd "$REPO"
git fetch --quiet origin
git reset --hard origin/main
REV=$(git rev-parse --short HEAD)

echo "[2/5] build SPA on server"
cd "$APP/wildwatch"
npm ci --no-audit --no-fund --silent
npx vite build

echo "[3/5] assemble release"
TS=$(date +%Y%m%d-%H%M%S)
REL="$BASE/releases/$TS"
mkdir -p "$REL/penguin-api"
cp -a "$APP/wildwatch/dist/." "$REL/"
find "$APP" -maxdepth 1 -name '*.php' ! -name 'secrets.php' ! -name 'secrets.php.sample' -exec cp {} "$REL/penguin-api/" \;
ln -sfn penguin-api "$REL/api"
ln -sfn "$BASE/shared/secrets.php" "$REL/penguin-api/secrets.php"
sudo chown -R wildwatch:wildwatch "$REL/penguin-api"

echo "[4/5] flip + smoke test"
PREV=$(readlink -f "$BASE/current" || true)
ln -sfn "$REL" "$BASE/current"
spa=$(curl -s -o /dev/null -w '%{http_code}' --resolve wildwatch.co.nz:443:127.0.0.1 https://wildwatch.co.nz/ || echo 000)
api=$(curl -s -o /dev/null -w '%{http_code}' --resolve wildwatch.co.nz:443:127.0.0.1 https://wildwatch.co.nz/api/snapshot.php || echo 000)
if [ "$spa" != "200" ] || [ "$api" != "401" ]; then
  [ -n "$PREV" ] && ln -sfn "$PREV" "$BASE/current"
  echo "SMOKE FAILED (spa=$spa api=$api) — rolled back to $PREV" >&2
  exit 1
fi

echo "[5/5] prune old releases (keep 5)"
# penguin-api/*.php in each release are chowned to the wildwatch pool user, so the
# deploy user needs sudo to remove old releases.
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r sudo rm -rf
echo "OK: deployed $TS @ $REV (spa=$spa api=$api)"
