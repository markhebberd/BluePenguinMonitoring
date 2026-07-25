#!/bin/bash
# Starts MariaDB and Apache in one container, and shuts MariaDB down cleanly on stop.
# root in the DB authenticates via unix_socket, so there is no root password anywhere —
# `docker exec wildwatch mariadb -uroot` just works, and nothing outside can use it
# (the server binds to 127.0.0.1 inside the container's own namespace).
set -euo pipefail

DATADIR=/var/lib/mysql
FRESH=0

# Debian's packaging leaves the socket directory to systemd-tmpfiles, which isn't running
# here — without this mariadbd aborts with "Bind on unix socket: No such file or directory".
install -d -o mysql -g mysql -m 755 /run/mysqld

if [ ! -d "$DATADIR/mysql" ]; then
  echo "[entrypoint] initialising database in $DATADIR"
  mariadb-install-db --user=mysql --datadir="$DATADIR" --skip-test-db >/dev/null
  FRESH=1
fi
chown -R mysql:mysql "$DATADIR"

mariadbd --user=mysql --datadir="$DATADIR" &
DB_PID=$!

printf '[entrypoint] waiting for mariadb'
for _ in $(seq 1 60); do
  if mariadb -uroot -e "SELECT 1" >/dev/null 2>&1; then echo " — up"; break; fi
  printf '.'; sleep 1
done
mariadb -uroot -e "SELECT 1" >/dev/null 2>&1 || { echo " — FAILED to start" >&2; exit 1; }

# Two restore slots: the nightly job wipes and rebuilds the inactive one, verifies it, then
# flips /var/www/shared/active_db. A failed restore leaves last night's copy serving.
if [ "$FRESH" = 1 ]; then
  echo "[entrypoint] creating slots + app users"
  mariadb -uroot <<SQL
CREATE DATABASE IF NOT EXISTS ww_a CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS ww_b CHARACTER SET utf8mb4;
-- Both hosts on purpose: MariaDB reads 'localhost' as the unix socket only, so a PHP
-- connection to 127.0.0.1 is a *different* account and would be refused with error 1130.
CREATE USER IF NOT EXISTS 'ww'@'localhost'   IDENTIFIED BY '${WW_DB_PASS:?WW_DB_PASS not set}';
CREATE USER IF NOT EXISTS 'ww'@'127.0.0.1'   IDENTIFIED BY '${WW_DB_PASS}';
-- ALL, to match production's app user: crud.php lazily runs CREATE TABLE IF NOT EXISTS
-- (e.g. sessions) on login, which needs more than DML. The grant is on the ww_% pattern,
-- so it survives the nightly DROP/CREATE of the restore slots.
GRANT ALL PRIVILEGES ON \`ww\_%\`.* TO 'ww'@'localhost';
GRANT ALL PRIVILEGES ON \`ww\_%\`.* TO 'ww'@'127.0.0.1';
CREATE USER IF NOT EXISTS 'ww_ro'@'localhost' IDENTIFIED BY '${WW_DB_RO_PASS:-$WW_DB_PASS}';
CREATE USER IF NOT EXISTS 'ww_ro'@'127.0.0.1' IDENTIFIED BY '${WW_DB_RO_PASS:-$WW_DB_PASS}';
GRANT SELECT ON \`ww\_%\`.* TO 'ww_ro'@'localhost';
GRANT SELECT ON \`ww\_%\`.* TO 'ww_ro'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
fi

shutdown() {
  echo "[entrypoint] stopping"
  apache2ctl -k graceful-stop 2>/dev/null || true
  mariadb-admin -uroot shutdown 2>/dev/null || true
  wait "$DB_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# APACHE_* vars come from Debian's envvars file, which apache2ctl sources for us.
apache2ctl -D FOREGROUND &
WEB_PID=$!

# If either daemon dies, let the container die too so Docker restarts it.
wait -n "$DB_PID" "$WEB_PID"
echo "[entrypoint] a service exited — shutting down" >&2
shutdown
