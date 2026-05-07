#!/bin/bash
# Deploy wildwatch website: commit, push, build, FTP upload
set -e

cd "$(dirname "$0")"

# Require commit message as argument
MSG="$1"
if [ -z "$MSG" ]; then
    echo "Usage: ./deploy-website.sh \"commit message\""
    exit 1
fi

# Load FTP credentials
if [ -f /home/mark/PenguinMonitor/.env ]; then
    source /home/mark/PenguinMonitor/.env
elif [ -f .env ]; then
    source .env
else
    echo "No .env with FTP_USER and FTP_PASS found"
    exit 1
fi

# 1. Commit and push
echo "Committing..."
git add website/ .cpanel.yml
git commit -m "$MSG" || echo "Nothing to commit"
echo "Pushing..."
git push origin main

# 2. Build
echo "Building..."
cd website/wildwatch
npm run build 2>&1 || { npx tsc -b && npx vite build; }
cd ../..

# 3. FTP deploy
echo "Deploying via FTP..."
FTP_OPTS="--ftp-ssl -k -u ${FTP_USER}:${FTP_PASS}"
FTP_BASE="ftp://wildwatch.co.nz:21/public_html"

# PHP files
for f in website/*.php; do
    [ -f "$f" ] && curl -s $FTP_OPTS -T "$f" "$FTP_BASE/penguin-api/$(basename $f)"
done

# Frontend
curl -s $FTP_OPTS -T website/wildwatch/dist/index.html "$FTP_BASE/index.html"
for f in website/wildwatch/dist/assets/*; do
    curl -s $FTP_OPTS -T "$f" "$FTP_BASE/assets/$(basename $f)"
done

# Static files
for f in website/wildwatch/dist/appicon.png website/wildwatch/dist/favicon.svg website/wildwatch/dist/icons.svg website/wildwatch/dist/manifest.json; do
    [ -f "$f" ] && curl -s $FTP_OPTS -T "$f" "$FTP_BASE/$(basename $f)"
done

echo "Deployed!"
