#!/usr/bin/env bash
# Runs ON THE VPS. Emits a tar.gz of everything needed to rebuild wildwatch.co.nz that is
# NOT in the database and NOT in the public git repo: credentials, web/mail server config,
# cron, and a snapshot of the machine's shape (packages, units, firewall, live DNS).
#
# Canonical copy lives here in the repo; install to /usr/local/bin/rebuild-kit.sh on the VPS.
# Invoked by the NAS over a forced-command SSH key (same pattern as deploy.sh), so it writes
# the tar to stdout and every log line to stderr.
#
#   ssh -i /volume1/wildwatch/shared/id_nas mark@wildwatch.co.nz > kit.tar.gz
#
# Args: --with-mail  also include the Maildirs (mailbox contents, not just mail config).
set -uo pipefail
umask 077

# Under a forced-command SSH key the caller's arguments arrive in SSH_ORIGINAL_COMMAND
# rather than "$@". Exact-match only — never eval what the client sent.
REQ="${1:-${SSH_ORIGINAL_COMMAND:-}}"
WITH_MAIL=0
[ "$REQ" = "--with-mail" ] && WITH_MAIL=1

WORK=$(mktemp -d /tmp/rebuild-kit.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
KIT="$WORK/kit"
mkdir -p "$KIT/files" "$KIT/state"

copy() {  # copy preserving path, quietly skipping anything absent on this host
  for src in "$@"; do
    [ -e "$src" ] || { echo "skip (absent): $src" >&2; continue; }
    mkdir -p "$KIT/files$(dirname "$src")"
    cp -a "$src" "$KIT/files$src" 2>/dev/null || echo "skip (unreadable): $src" >&2
  done
}

# ---- wildwatch app secrets + serving config -------------------------------
# The whole shared/ dir: secrets.php, secrets.env (cron/backup creds) and shared/ssh
# (the disk-check key pair + known_hosts).
copy /var/www/wildwatch/shared \
     /etc/nginx/sites-available \
     /etc/nginx/snippets

for pool in /etc/php/*/fpm/pool.d; do copy "$pool"; done

# ---- backups + scheduled jobs --------------------------------------------
copy /etc/cron.d /usr/local/bin/db-backup.sh /usr/local/bin/rebuild-kit.sh
crontab -l > "$KIT/state/crontab-root.txt" 2>/dev/null

# ---- mail server (see MAIL-SERVER.md) ------------------------------------
copy /etc/dovecot/local.conf /etc/dovecot/passwd \
     /etc/postfix/main.cf /etc/postfix/master.cf \
     /etc/postfix/vmailbox /etc/postfix/virtual /etc/postfix/sasl_passwd \
     /etc/rspamd/local.d \
     /etc/roundcube/config.inc.php /etc/roundcube/plugins/password/config.inc.php \
     /usr/local/bin/rc-chpasswd \
     /etc/letsencrypt/renewal-hooks/deploy/reload-mail.sh

# DKIM private keys — without these, mail from a rebuilt server fails authentication
# until DNS is re-published. Small, and useless to leave out of a rebuild kit.
copy /var/lib/rspamd/dkim /etc/dkim

if [ "$WITH_MAIL" = 1 ]; then
  copy /var/mail/wildwatch.co.nz /home/vmail
fi

# ---- machine shape: enough to re-provision without guessing ---------------
{
  echo "# host:    $(hostname -f 2>/dev/null || hostname)"
  echo "# kit at:  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "# os:      $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
  echo "# kernel:  $(uname -r)"
  echo "# mail:    $([ "$WITH_MAIL" = 1 ] && echo included || echo 'config only (no Maildirs)')"
} > "$KIT/MANIFEST.txt"

dpkg --get-selections            > "$KIT/state/packages.txt"        2>/dev/null
systemctl list-unit-files --state=enabled > "$KIT/state/units-enabled.txt" 2>/dev/null
ufw status verbose               > "$KIT/state/firewall.txt"        2>/dev/null
ip -brief addr                   > "$KIT/state/addresses.txt"       2>/dev/null
certbot certificates             > "$KIT/state/certs.txt"           2>/dev/null

# Live DNS, so a rebuild elsewhere can reproduce the zone (Porkbun holds the master).
if command -v dig >/dev/null; then
  {
    for rr in A AAAA MX TXT NS CAA; do dig +short "$rr" wildwatch.co.nz | sed "s/^/$rr /"; done
    for host in mail www; do echo "A $host $(dig +short "$host.wildwatch.co.nz")"; done
    echo "TXT _dmarc $(dig +short TXT _dmarc.wildwatch.co.nz)"
    for sel in dkim default mail; do
      v=$(dig +short TXT "$sel._domainkey.wildwatch.co.nz"); [ -n "$v" ] && echo "TXT $sel._domainkey $v"
    done
  } > "$KIT/state/dns.txt" 2>/dev/null
fi

# Database credentials are in secrets.php above; record the grants too, since the
# rebuild has to recreate the users before the dump will load.
if command -v mariadb >/dev/null; then
  mariadb -N -B -e "SELECT CONCAT('-- ', user, '@', host) FROM mysql.user WHERE user LIKE 'wildwatch%';" \
    > "$KIT/state/db-users.txt" 2>/dev/null
fi

# Fail loudly rather than shipping a tar that is technically valid and practically
# useless: a kit without secrets.php cannot rebuild anything, and a silent empty
# backup is the failure mode this whole exercise exists to catch.
for required in files/var/www/wildwatch/shared/secrets.php files/etc/nginx/sites-available; do
  if [ ! -e "$KIT/$required" ]; then
    echo "rebuild-kit: FATAL — $required missing; wrong host, or not running as root?" >&2
    exit 1
  fi
done

tar -czf - -C "$WORK" kit
echo "rebuild-kit: $(du -sh "$KIT" | cut -f1) assembled" >&2
