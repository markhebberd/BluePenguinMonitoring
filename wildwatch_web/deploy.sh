#!/usr/bin/env bash
# Pull-and-build deploy for wildwatch. Runs on the VPS (triggered by GitHub Actions).
# git pull -> npm build -> assemble atomic release -> chown -> flip -> smoke test -> rollback.
#
# Canonical copy. The live script lives at /var/www/wildwatch/deploy.sh on the VPS
# (invoked via the CI forced-command SSH key). Keep the two in sync when editing.
set -euo pipefail
# Read the whole script before running any of it. Step 1 pulls, which overwrites this very file
# — the live deploy.sh is a symlink into the repo — and bash otherwise carries on reading the new
# bytes from its old offset, running whatever happens to be there. The braces make that safe.
{
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
# The breeding algorithm again, bundled for node: reports.php runs the SAME source the SPA
# does rather than a PHP port of it, which is what stopped the two drifting apart. The NAS
# mirror has no build step — it copies this artifact out of the release we assemble below.
npm run build:cli --silent
echo '{}' | node dist-node/breeding-cli.mjs > /dev/null   # a broken bundle fails here, before the flip

echo "[3/5] assemble release"
TS=$(date +%Y%m%d-%H%M%S)
REL="$BASE/releases/$TS"
mkdir -p "$REL/penguin-api"
cp -a "$APP/wildwatch/dist/." "$REL/"
find "$APP" -maxdepth 1 -name '*.php' ! -name 'secrets.php' ! -name 'secrets.php.sample' -exec cp {} "$REL/penguin-api/" \;
cp "$APP/wildwatch/dist-node/breeding-cli.mjs" "$REL/penguin-api/"   # reports.php spawns this
ln -sfn penguin-api "$REL/api"
ln -sfn "$BASE/shared/secrets.php" "$REL/penguin-api/secrets.php"
sudo chown -R wildwatch:wildwatch "$REL/penguin-api"

echo "[4/5] flip + smoke test"
PREV=$(readlink -f "$BASE/current" || true)
ln -sfn "$REL" "$BASE/current"
# php-fpm's realpath cache can keep serving files from the OLD release after the
# symlink flip, mixing releases (fatal when function signatures changed). Reload
# clears opcache/realpath so the smoke test below exercises the new code.
sudo systemctl reload php8.4-fpm
spa=$(curl -s -o /dev/null -w '%{http_code}' --resolve wildwatch.co.nz:443:127.0.0.1 https://wildwatch.co.nz/ || echo 000)
api=$(curl -s -o /dev/null -w '%{http_code}' --resolve wildwatch.co.nz:443:127.0.0.1 https://wildwatch.co.nz/api/snapshot.php || echo 000)
if [ "$spa" != "200" ] || [ "$api" != "401" ]; then
  [ -n "$PREV" ] && ln -sfn "$PREV" "$BASE/current"
  echo "SMOKE FAILED (spa=$spa api=$api) — rolled back to $PREV" >&2
  exit 1
fi

# Status codes don't catch a 200 the phone can't parse: nestcheck deserialises into typed classes,
# so a field of the wrong JSON type kills its whole download while the server sees nothing wrong.
# Assert the payload shape against what the app declares, and roll back if it drifted.
if ! contract=$(sudo -u wildwatch php "$REL/penguin-api/contract_check.php" 2>&1); then
  [ -n "$PREV" ] && ln -sfn "$PREV" "$BASE/current"
  sudo systemctl reload php8.4-fpm
  echo "$contract" >&2
  echo "CONTRACT FAILED — rolled back to $PREV" >&2
  exit 1
fi
echo "$contract"

echo "[5/5] prune old releases (keep 5)"
# penguin-api/*.php in each release are chowned to the wildwatch pool user, so the
# deploy user needs sudo to remove old releases.
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r sudo rm -rf
echo "OK: deployed $TS @ $REV (spa=$spa api=$api)"
exit 0
}
