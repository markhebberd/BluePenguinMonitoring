-- Two restore slots. The nightly job wipes and restores the inactive one, verifies it,
-- then flips /var/www/shared/active_db. A failed restore therefore never takes the
-- site down: it keeps serving the last good night.
CREATE DATABASE IF NOT EXISTS ww_a CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS ww_b CHARACTER SET utf8mb4;

-- App user (matches DB_USER in secrets.php). No DROP/CREATE — the restore runs as root.
GRANT SELECT, INSERT, UPDATE, DELETE ON `ww\_%`.* TO 'ww'@'%';

-- Read-only user for the admin SQL console (DB_RO_USER).
CREATE USER IF NOT EXISTS 'ww_ro'@'%' IDENTIFIED BY 'readonly-local-only';
GRANT SELECT ON `ww\_%`.* TO 'ww_ro'@'%';

FLUSH PRIVILEGES;
