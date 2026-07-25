<?php
/**
 * secrets.php for the NAS mirror. Copy to /volume1/wildwatch/shared/secrets.php,
 * fill in the passwords, chmod 640. Never rsynced — it is bind-mounted straight
 * over /var/www/html/api/secrets.php by docker-compose.
 *
 * The only unusual bit: DB_NAME is read from a file at request time, so the nightly
 * job can flip between the ww_a / ww_b restore slots atomically.
 */

$__active = @file_get_contents('/var/www/shared/active_db');
$__active = trim((string)$__active);
if ($__active !== 'ww_a' && $__active !== 'ww_b') $__active = 'ww_a';

define('DB_HOST', '127.0.0.1');     // MariaDB runs in this same container
define('DB_NAME', $__active);
define('DB_USER', 'ww');
define('DB_PASS', 'CHANGE_ME_MATCH_DB_APP_PASS');

define('DB_RO_USER', 'ww_ro');
define('DB_RO_PASS', 'CHANGE_ME_MATCH_DB_RO_PASS');

// Local-only API key. NOT the production key — nothing on the LAN needs that one,
// and the nightly download reads the production key from shared/nas.env instead.
define('API_KEY', 'CHANGE_ME_LOCAL_ONLY_KEY');
