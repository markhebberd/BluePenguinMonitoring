#!/bin/bash
set -e

cd "$(dirname "$0")/website/wildwatch"

# Lint: check for unstyled <a> tags
echo "Checking for unstyled links..."
BARE_LINKS=$(grep -n '<a ' src/App.tsx src/components/*.tsx 2>/dev/null | grep -v 'className' | grep -v "attribution\|'<a\|\"<a" || true)
if [ -n "$BARE_LINKS" ]; then
    echo "ERROR: Found <a> tags without className (will show default blue/underline):"
    echo "$BARE_LINKS"
    exit 1
fi

# Build
echo "Building..."
npx vite build 2>&1 | tail -5

# Load FTP creds
source /home/mark/PenguinMonitor/.env
CPANEL_URL="https://wildwatch.co.nz:2083"
CPANEL_AUTH="wildwatch:${FTP_PASS}"

upload() {
    local src="$1" dest_dir="$2"
    local filename=$(basename "$src")
    echo -n "  ${filename}..."
    local result=$(curl -s -k -u "$CPANEL_AUTH" "${CPANEL_URL}/execute/Fileman/save_file_content" --data-urlencode "file=${filename}" --data-urlencode "dir=${dest_dir}" --data-urlencode "content@${src}" --max-time 60 2>&1)
    if echo "$result" | grep -q '"status":1'; then
        echo " OK"
    else
        echo " FAILED"
        echo "$result" | head -3
        exit 1
    fi
}

echo "Deploying frontend..."
upload dist/index.html /public_html
for f in dist/assets/*; do
    upload "$f" /public_html/assets
done

# Deploy PHP
cd ../..
echo "Deploying PHP..."
for f in website/*.php; do
    [ -f "$f" ] && upload "$f" /public_html/penguin-api
done

echo "Deployed!"
