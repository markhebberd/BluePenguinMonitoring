<?php
// One-time deploy helper: copies dist files from repo to public_html
// Run via: curl https://wildwatch.co.nz/penguin-api/deploy_frontend.php?key=deploy2026
if (($_GET['key'] ?? '') !== 'deploy2026') { http_response_code(403); echo 'forbidden'; exit; }

$repoBase = dirname(__DIR__, 2); // up from public_html/penguin-api to repo root
$distDir = $repoBase . '/website/wildwatch/dist';
$pubDir = '/home/wildwatch/public_html';

// Try a few possible repo locations
$candidates = [
    $repoBase . '/website/wildwatch/dist',
    '/home/wildwatch/repositories/PenguinMonitor/website/wildwatch/dist',
    '/home/wildwatch/PenguinMonitor/website/wildwatch/dist',
];

$found = null;
foreach ($candidates as $c) {
    if (is_dir($c)) { $found = $c; break; }
}

if (!$found) {
    echo "dist dir not found. Tried:\n";
    foreach ($candidates as $c) echo "  $c\n";
    echo "\n__DIR__ = " . __DIR__ . "\n";
    echo "dirname(__DIR__, 2) = " . dirname(__DIR__, 2) . "\n";
    // List what exists
    $parent = dirname(__DIR__, 2);
    echo "\nListing $parent:\n";
    foreach (scandir($parent) ?: [] as $f) echo "  $f\n";
    exit;
}

echo "Found dist at: $found\n";

// Copy index.html
copy("$found/index.html", "$pubDir/index.html");
echo "Copied index.html\n";

// Copy assets
if (!is_dir("$pubDir/assets")) mkdir("$pubDir/assets", 0755, true);
foreach (glob("$found/assets/*") as $f) {
    copy($f, "$pubDir/assets/" . basename($f));
    echo "Copied assets/" . basename($f) . "\n";
}

// Copy static files
foreach (['favicon.svg', 'icons.svg', 'manifest.json'] as $file) {
    if (file_exists("$found/$file")) {
        copy("$found/$file", "$pubDir/$file");
        echo "Copied $file\n";
    }
}

echo "Done!\n";
