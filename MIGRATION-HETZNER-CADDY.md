# Migration runbook — Wildwatch → Hetzner VPS running Caddy

Move the **wildwatch** web stack (wildwatch.co.nz) off the cPanel shared host onto a
self-managed **Hetzner Cloud VPS** with **Caddy** as the web server, **rotating all
shared secrets** during the cutover (the DB password + `API_KEY` have lived in git
history and must be treated as compromised — a new host is the moment to kill them).

**Read `DEPLOYMENT.md` first.** It defines the architecture (static SPA + PHP API +
MySQL), the critical `/api` ↔ `/penguin-api` routing, the cron jobs, and where every
secret lives. This file is the **Hetzner + Caddy-specific** plan; it does not repeat
the architecture. `MIGRATION-TANTRIXLAB-VPS.md` is the Apache/nginx sibling of this
doc — the DB, secrets, rotation, and cutover steps are identical; only the web server
differs.

---

## 0. What changes vs. the current host (and vs. the Apache runbook)

| | cPanel host (now) | Hetzner + Caddy (target) |
|---|---|---|
| Web server | Apache + `.htaccess` | **Caddy** + a `Caddyfile` (no `.htaccess`) |
| TLS | cPanel AutoSSL | **Caddy automatic HTTPS** (Let's Encrypt, zero-config — no certbot) |
| HTTPS redirect | `.htaccess` rule | **automatic** (Caddy redirects HTTP→HTTPS by default) |
| SPA fallback | `.htaccess` rewrite | `try_files {path} /index.html` in the Caddyfile |
| PHP | host-managed | **php-fpm** you install, wired via Caddy `php_fastcgi` |
| DB | cPanel MySQL | **MariaDB** you install |
| Deploy transport | `deploy-web.sh` (cPanel UAPI :2083) | **`rsync` over SSH** (cPanel API unavailable) |
| Disk alerts | server `mail()` + external devian | keep **external devian** alert; server `mail()` optional (needs an MTA) |

`deploy-web.sh` will **not** work here (it speaks cPanel's file API). Keep its **lint +
`vite build`** steps; replace the upload with `rsync` (§4). `.htaccess` is **ignored by
Caddy** — its two jobs (force-HTTPS, SPA fallback) are done by the Caddyfile in §5.

---

## 1. Provision the Hetzner VPS

1. **Create the server** in Hetzner Cloud:
   - Image: **Ubuntu 24.04 LTS** (or Debian 12). Examples below use Ubuntu 24.04
     (PHP 8.3, socket `/run/php/php8.3-fpm.sock`). On Debian 12 it's PHP 8.2
     (`php8.2-fpm.sock`) — adjust the socket path in the Caddyfile to match.
   - Size: a **CX22 / CAX11** (2 vCPU, 4 GB) is plenty. CAX (ARM) is fine — all
     packages below exist for arm64.
   - Add your SSH key at creation.
2. **Hetzner Cloud Firewall** (and/or `ufw`): allow inbound **22, 80, 443** only.
   Ports 80 **and** 443 must be open to the internet or Caddy can't get a cert.
   ```bash
   sudo ufw allow 22,80,443/tcp && sudo ufw enable
   ```
3. **Packages:**
   ```bash
   sudo apt update && sudo apt -y upgrade
   # PHP-FPM + extensions the API needs (PDO MySQL, mbstring, xml/curl used by some endpoints)
   sudo apt -y install php-fpm php-mysql php-mbstring php-xml php-curl \
       mariadb-server rsync curl debian-keyring debian-archive-keyring apt-transport-https
   # Caddy (official apt repo)
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
       | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
       | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt -y install caddy
   sudo systemctl enable --now php8.3-fpm mariadb caddy   # adjust php version
   ```
   Requirements recap (from DEPLOYMENT.md): **PHP 8.x** with `pdo_mysql`,
   `getallheaders()`, `mail()` (optional); **MariaDB 10.3+** utf8mb4.

> **php-fpm user:** on Debian/Ubuntu php-fpm runs as `www-data`. Caddy runs as the
> `caddy` user. They talk over the fpm **unix socket**, so Caddy doesn't need to be in
> `www-data`, but the docroot must be **readable** by both and `secrets.php` readable by
> `www-data` (the fpm worker). See §4.6.

---

## 2. Pre-migration prep (before touching DNS)

1. **Lower DNS TTL** for `wildwatch.co.nz` to **300s** a day ahead — fast, reversible cutover.
2. **Fresh backup** of the live DB (seed + rollback point):
   ```bash
   ./backup.sh            # writes backups/YYYY/MM/YYYY-MM-DD.sql.gz
   ```
3. **Generate the new secrets** now; store them safely (NOT in git):
   ```bash
   openssl rand -hex 24      # → new API_KEY
   openssl rand -base64 24   # → new DB password
   ```
   Do **not** touch the Android keystore/signing password (see §8).

---

## 3. Database on the VPS (with the NEW password)

```bash
sudo mysql_secure_installation   # set a root password, drop test db
sudo mysql
```
```sql
CREATE DATABASE wildwatch_nestcheck CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wildwatch_nestcheck_api'@'localhost' IDENTIFIED BY '<NEW-DB-PASSWORD>';
GRANT ALL PRIVILEGES ON wildwatch_nestcheck.* TO 'wildwatch_nestcheck_api'@'localhost';
FLUSH PRIVILEGES;
```
Restore the **latest backup dump** (schema **and** data — do **not** use
`database_schema.sql`, it has drifted from production):
```bash
scp backups/2026/07/<newest>.sql.gz  user@<VPS-IP>:/tmp/
ssh user@<VPS-IP> 'gunzip < /tmp/<newest>.sql.gz | mysql -u root -p wildwatch_nestcheck'
```

---

## 4. Deploy the code to the VPS

Docroot: **`/var/www/wildwatch/`** (the SPA dist), PHP in **`/var/www/wildwatch/penguin-api/`**.

### 4.1 Build the SPA (on your dev/build machine)
```bash
cd wildwatch_web/wildwatch && npm install && npx vite build      # → dist/
```
(Keep the unstyled-`<a>` lint from `deploy-web.sh` if you like — it's just a grep.)

### 4.2 Create the docroot and upload the frontend
```bash
ssh user@<VPS-IP> 'sudo mkdir -p /var/www/wildwatch && sudo chown $USER /var/www/wildwatch'
rsync -av --delete wildwatch_web/wildwatch/dist/  user@<VPS-IP>:/var/www/wildwatch/
```
`rsync` of the whole `dist/` ships **everything** — `index.html`, `assets/`, and the
static files (`favicon.svg`, `icons.svg`, `manifest.json`, `appicon.png`,
`loading-bg.webp`). (Unlike `deploy-web.sh`, which only pushes `index.html` + `assets/`
and assumes the icons were uploaded once — with rsync you don't have that gotcha.)

### 4.3 Upload the PHP API
```bash
rsync -av --include='*.php' --exclude='*' wildwatch_web/  user@<VPS-IP>:/var/www/wildwatch/penguin-api/
```

### 4.4 The `/api` alias (critical — see DEPLOYMENT.md §1)
The SPA fetches **relative `/api/...`**; the PHP lives in `penguin-api/`. Make `/api`
resolve via a symlink in the docroot:
```bash
ssh user@<VPS-IP> 'cd /var/www/wildwatch && ln -sfn penguin-api api'
```
(`ops`/`backup.sh` use `/penguin-api/`; the SPA uses `/api/` — the symlink serves both.)

### 4.5 `secrets.php` with the NEW credentials
`config.php` is tracked code that `require_once`s the git-ignored `secrets.php`. Create
it on the VPS from the template, with the **new** values:
```bash
ssh user@<VPS-IP>
cp /var/www/wildwatch/penguin-api/secrets.php.sample /var/www/wildwatch/penguin-api/secrets.php
# edit: DB_HOST=localhost, DB_NAME=wildwatch_nestcheck,
#       DB_USER=wildwatch_nestcheck_api, DB_PASS=<NEW-DB-PASSWORD>, API_KEY=<NEW-API_KEY>
```

### 4.6 Ownership / permissions
php-fpm runs as `www-data` and must read the docroot (and write nothing there):
```bash
ssh user@<VPS-IP> 'sudo chown -R www-data:www-data /var/www/wildwatch && \
                   sudo chmod 640 /var/www/wildwatch/penguin-api/secrets.php && \
                   sudo chown www-data:www-data /var/www/wildwatch/penguin-api/secrets.php'
```

---

## 5. Caddy configuration (the crux)

Write **`/etc/caddy/Caddyfile`**:

```caddy
wildwatch.co.nz, www.wildwatch.co.nz {
    root * /var/www/wildwatch
    encode zstd gzip

    # Run ONLY real .php requests through php-fpm. Scoping to *.php is essential:
    # the default php_fastcgi would funnel unknown paths to index.php, but this is a
    # SPA — unknown paths must fall through to index.html (below), not PHP.
    @php path *.php
    php_fastcgi @php unix//run/php/php8.3-fpm.sock     # match installed PHP version

    # SPA fallback: serve the real file if it exists (assets, icons, /api/*.php handled
    # above), otherwise hand the client-side router index.html (/box/4, /bird/123, …).
    try_files {path} /index.html
    file_server
}
```

Reload and check:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
journalctl -u caddy -f          # watch for cert issuance / errors
```

**Why this works / what it replaces:**
- **HTTPS + redirect:** Caddy serves HTTPS automatically and 301-redirects HTTP→HTTPS
  with no config — this replaces the `.htaccess` force-HTTPS block. A public cert is
  issued from Let's Encrypt **once DNS points at the VPS and 80/443 are open** (so the
  real cert happens at cutover, §6).
- **SPA fallback:** `try_files {path} /index.html` replaces the `.htaccess`
  `!-f !-d → /index.html` rule. Because `php_fastcgi` is scoped to `@php` (`*.php`), the
  `/api/` exclusion from `.htaccess` is implicit: `/api/snapshot.php` matches `@php` and
  runs PHP; `/box/4` matches neither a file nor `*.php`, so it serves `index.html`.
- **Authorization header:** the API auth reads `$_SERVER['HTTP_AUTHORIZATION']` (Bearer
  tokens) and `getallheaders()['X-API-Key']`. Caddy's `php_fastcgi` forwards request
  headers to php-fpm, and `getallheaders()` is available under php-fpm — so Bearer login
  **and** the `X-API-Key` cron/backup path both work with no extra rules. (This is the
  classic Apache+CGI footgun that Caddy avoids — but still verify in §6.)

> **php-fpm socket path varies:** Ubuntu 24.04 = `/run/php/php8.3-fpm.sock`,
> Debian 12 = `/run/php/php8.2-fpm.sock`. Confirm with `ls /run/php/`. If you ever switch
> to a TCP pool, use `php_fastcgi 127.0.0.1:9000` instead.

> **Large responses:** `backup.php` streams a gzipped `mysqldump`. Caddy streams
> responses fine (no buffering cap to tune). If a big backup 504s, raise php-fpm
> `request_terminate_timeout` and PHP `max_execution_time`/`memory_limit`, not Caddy.

---

## 6. TLS, smoke test before DNS, then cutover

Caddy can't get a **public** cert until `wildwatch.co.nz` resolves to the VPS. To test
**before** flipping DNS, temporarily use Caddy's local CA:

1. In the Caddyfile site block, add `tls internal` (self-signed), `reload`, then from
   your machine pin the host and exercise the app:
   ```bash
   curl -k --resolve wildwatch.co.nz:443:<VPS-IP> https://wildwatch.co.nz/ -I
   # API read with the NEW key (backup endpoint uses X-API-Key on GET):
   curl -k --resolve wildwatch.co.nz:443:<VPS-IP> -H "X-API-Key: <NEW-API_KEY>" \
        https://wildwatch.co.nz/api/backup.php -o /tmp/t.sql.gz -w '%{http_code}\n'
   ```
   Confirm: SPA paints, an SPA route like `/box/1` returns `index.html`,
   `/api/snapshot.php` returns data with a valid session (log in through the pinned
   site), a **test write persists**, and the backup downloads (200, file > 1 KB).
   *(A `--resolve`-pinned browser session via a host entry is the easiest way to log in
   and test writes.)*
2. **Remove `tls internal`** and `reload`. Now do the **cutover**: point the
   `wildwatch.co.nz` (and `www`) **A record at the VPS IP**. Within seconds Caddy
   provisions a real Let's Encrypt cert (watch `journalctl -u caddy -f`).
3. Keep the **old host running** until the VPS is confirmed good; low TTL makes rollback
   a one-line DNS revert.

Alternative to `tls internal`: point a throwaway subdomain (e.g.
`vps.wildwatch.co.nz`) at the VPS first so Caddy issues a real cert for it, test there,
then add the apex — but the `tls internal` + `--resolve` path above needs no extra DNS.

---

## 7. Cron jobs on the VPS

(See DEPLOYMENT.md §6 for what each does.) Recreate on the new host:

- **Disk sample + descent alert** — these read the **VPS's own** filesystem, so they
  must run on the VPS. Add to root's crontab, hitting the local site over the public URL
  (post-cutover DNS resolves to itself):
  ```cron
  */15 * * * * curl -s https://wildwatch.co.nz/api/disk_check.php >/dev/null
  # descent alert passes the key inline (see scripts/wildwatch-disk-alert.sh):
  */15 * * * * curl -s "https://wildwatch.co.nz/api/disk_history.php?cron=<NEW-API_KEY>" >/dev/null
  ```
- **Daily DB backup** — runs on **devian** (`mark@devian`), not the web host, and pulls
  from `https://wildwatch.co.nz/api/backup.php` with `X-API-Key`. The **domain doesn't
  change**, so the only edit is the **new `API_KEY` in devian's `.env`** (§8). Watch
  `backups/backup.log` for `401`s after rotation.
- **server `mail()`** for alert email is unreliable without an MTA. Either keep relying
  on the **external devian himalaya alert** (recommended — DEPLOYMENT.md), or install a
  send-only MTA on the VPS (`sudo apt install msmtp-mta` + a relay) and confirm
  `disk_check.php`'s hard-coded sender works.

---

## 8. Finish the key rotation (after the VPS is serving)

The new `API_KEY` only fully takes effect once every consumer uses it — update in this
order to avoid a 401 window (full detail in `MIGRATION-TANTRIXLAB-VPS.md` §6):

1. **VPS `secrets.php`** — already has the new key + DB pass (§4.5). ✅ source of truth.
2. **`.env` on the build machine and on devian** — set `API_KEY=<NEW-API_KEY>` (covers
   `backup.sh` and the disk-alert script, which read it).
3. **nestcheck** (`nestcheck/secrets.props` → `<BoxTagsApiKey>`) — set the new key,
   **rebuild + redeploy** the Android app.
4. **Transitional dual-key (recommended if field devices are live):** the API also
   accepts per-observer `api_key`s (`requireReadAuth`). To avoid bricking old nestcheck
   installs the instant you rotate, add the **old** key as a per-observer `api_key` row
   temporarily, then delete it once all devices are updated.

> **Do NOT rotate the Android keystore/signing password.** It signs app updates;
> changing it locks out existing installs. Only `API_KEY` + `DB_PASS` rotate here.

---

## 9. Decommission

1. Leave the old cPanel host up (read-only) for a few days as a fallback.
2. Once the VPS is proven: take a **final backup from the VPS**, then tear down the old
   host (or at least revoke its DB user + delete its `config.php`/`secrets.php`).
3. The old DB password and old `API_KEY` are now **dead** — their presence in git
   history is no longer a live exposure (the whole point of rotating during the move).
   Optional: scrub history with `git filter-repo` if you want them gone from GitHub too.

---

## 10. Cutover checklist

- [ ] Hetzner VPS provisioned; firewall allows 22/80/443
- [ ] Caddy + php-fpm + MariaDB installed and enabled; fpm socket path confirmed
- [ ] New `API_KEY` + new DB password generated and stored safely
- [ ] DB + user created with **new** password; **latest backup dump** restored (not `database_schema.sql`)
- [ ] SPA built and rsynced to `/var/www/wildwatch/` (incl. static icons)
- [ ] PHP rsynced to `penguin-api/`; `api → penguin-api` symlink created
- [ ] `secrets.php` created from sample with **new** DB pass + **new** API key; owned by `www-data`, mode 640
- [ ] `Caddyfile` in place; `caddy validate` passes; `php_fastcgi` scoped to `*.php`; `try_files … /index.html`
- [ ] Pre-DNS smoke test via `tls internal` + `--resolve`: SPA loads, SPA route serves index.html, `/api` reads **and writes**, `/api/backup.php` downloads with the new key, **Bearer login works**
- [ ] `tls internal` removed; DNS A records (apex + www) cut over to VPS IP (low TTL)
- [ ] Real Let's Encrypt cert issued (check `journalctl -u caddy`)
- [ ] VPS crons added (disk_check, disk_history with new key); devian `.env` updated; backup.log clean (no 401)
- [ ] nestcheck rebuilt with new key (transitional dual-key if field devices live)
- [ ] Old host decommissioned; old secrets dead

---

## 11. Quick reference (Caddy specifics)

- Docroot: `/var/www/wildwatch/` (dist) · PHP: `/var/www/wildwatch/penguin-api/` · `api → penguin-api` symlink
- Web server config: `/etc/caddy/Caddyfile` · `caddy validate` / `systemctl reload caddy` / `journalctl -u caddy -f`
- TLS: automatic (Let's Encrypt) once DNS points to the VPS — no certbot
- Deploy: `npx vite build` then `rsync` (no `deploy-web.sh` — it's cPanel-only)
- Secrets to rotate on migration: `DB_PASS`, `API_KEY` (NOT the Android keystore)
- Everything else (architecture, `/api` rationale, schema-of-record = latest backup): **DEPLOYMENT.md**
