#!/bin/bash
# Runs ON THE VPS. Emits the currently-deployed release as a tar.gz on stdout, laid out
# the way the NAS serves it: SPA files at the root, PHP API under api/. This is what makes
# the mirror's app code track production without anything running on a dev machine.
#
# Excluded: secrets.php (the NAS has its own), and .htaccess (it force-redirects to HTTPS,
# which would break the plain-HTTP LAN mirror). Reached via the nas-fetch forced command.
set -uo pipefail
umask 077

REL=$(readlink -f /var/www/wildwatch/current 2>/dev/null)
[ -d "$REL" ] || { echo "release-tar: no current release at /var/www/wildwatch/current" >&2; exit 1; }

WORK=$(mktemp -d /tmp/release-tar.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/app"
mkdir -p "$APP/api"

# SPA: everything at the release root except the two api directories and .htaccess.
tar -c -C "$REL" --exclude='./penguin-api' --exclude='./api' --exclude='./.htaccess' . \
  | tar -x -C "$APP"

# PHP API -> app/api, minus credentials.
cp "$REL"/penguin-api/*.php "$APP/api/" 2>/dev/null || true
rm -f "$APP/api/secrets.php" "$APP/api/secrets.php.sample"

# Sanity: refuse to ship an empty or broken release rather than blanking the mirror.
[ -f "$APP/index.html" ]     || { echo "release-tar: no index.html in release" >&2; exit 1; }
ls "$APP"/api/*.php >/dev/null 2>&1 || { echo "release-tar: no PHP API in release" >&2; exit 1; }

# Stamp which release this is, so the NAS can show it on the status page.
{ basename "$REL"; git -C /var/www/wildwatch/repo rev-parse --short HEAD 2>/dev/null; } \
  | paste -sd' ' - > "$APP/.release" 2>/dev/null || true

tar -czf - -C "$WORK" app
