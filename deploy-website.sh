#!/bin/bash
# Deploy wildwatch website: commit, push, then upload to server
set -e

cd "$(dirname "$0")"

# Load FTP credentials from .env (not in git)
if [ -f .env ]; then
    source .env
else
    echo "Create .env with FTP_USER and FTP_PASS"
    exit 1
fi

# 1. Check for uncommitted changes
if ! git diff --quiet website/ .cpanel.yml || ! git diff --cached --quiet; then
    echo "Committing changes..."
    git add website/ .cpanel.yml
    git status --short website/
    read -p "Commit message: " MSG
    if [ -z "$MSG" ]; then
        echo "No commit message, aborting."
        exit 1
    fi
    git commit -m "$MSG"
    echo "Pushing to GitHub..."
    git push origin main
else
    echo "No changes to commit."
fi

# 2. Build React app
echo "Building website..."
cd website/wildwatch
npm run build
cd ../..

# 3. Deploy via FTP
echo "Deploying to server..."
FTP_OPTS="--ftp-ssl -k -u ${FTP_USER}:${FTP_PASS}"
FTP_BASE="ftp://wildwatch.co.nz:21/public_html"

# Upload PHP and SQL to penguin-api/
for f in website/*.php website/*.sql; do
    [ -f "$f" ] && curl -s $FTP_OPTS -T "$f" "$FTP_BASE/penguin-api/$(basename $f)"
done

# Upload built frontend
curl -s $FTP_OPTS -T website/wildwatch/dist/index.html "$FTP_BASE/index.html"
for f in website/wildwatch/dist/assets/*; do
    curl -s $FTP_OPTS -T "$f" "$FTP_BASE/assets/$(basename $f)"
done

echo "Deployed!"
