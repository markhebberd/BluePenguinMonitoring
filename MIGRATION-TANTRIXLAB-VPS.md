# Migration runbook — Wildwatch → tantrixlab VPS

Move the **wildwatch** web stack (wildwatch.co.nz) off the cPanel shared host and onto
the self-managed VPS that hosts **tantrixlab.com**, **rotating all shared secrets as
part of the cutover** so the credentials currently sitting in git history become
useless once the old host is gone.

Read `DEPLOYMENT.md` first — it describes the architecture (static SPA + PHP API +
MySQL), the `/api` ↔ `/penguin-api` alias, and where every secret lives. This file is
the VPS-specific plan + the rotation procedure.

> **Why rotate now:** the DB password and `API_KEY` were committed to git for a long
> time, so they must be treated as compromised. A server migration is the natural
> moment to change them — new host, new secrets, then decommission the old host.

---

## 0. What changes vs. the current host

| | cPanel shared host (now) | tantrixlab VPS (target) |
|---|---|---|
| Deploy transport | `deploy-web.sh` (cPanel UAPI, port 2083) | **`rsync`/`scp`** — cPanel API not available |
| Web server | Apache + `.htaccess` | Apache (reuse `.htaccess`) **or** nginx (translate rules) |
| PHP | host-managed | install **PHP 8.x + php-fpm** yourself |
| DB | cPanel MySQL | install **MariaDB/MySQL** yourself |
| TLS | cPanel AutoSSL | **certbot / Let's Encrypt** |
| Disk alerts | server `mail()` (unreliable) + external devian himalaya | keep the **external devian** alert; server `mail()` optional |

`deploy-web.sh` will **not** work against the VPS (it speaks cPanel's file API). Use
`rsync` (see §4.4). Keep the lint + `vite build` steps; only the upload transport changes.

---

## 1. VPS prerequisites

Install on the VPS (Debian/Ubuntu example):

```bash
sudo apt update
sudo apt install -y apache2 php php-fpm php-mysql php-mbstring php-xml \
    mariadb-server certbot python3-certbot-apache rsync
sudo a2enmod rewrite proxy_fcgi setenvif
sudo systemctl enable --now apache2 mariadb
```

Requirements recap: **PHP 8.x** with `pdo_mysql`, `getallheaders()`; **MariaDB 10.3+ /
MySQL 5.7+** (utf8mb4); **Apache `mod_rewrite`** (for the HTTPS redirect + SPA
fallback); a valid **TLS cert**.

---

## 2. Pre-migration prep (before touching DNS)

1. **Lower DNS TTL** for `wildwatch.co.nz` to 300s a day ahead, so cutover is fast/reversible.
2. **Take a fresh backup** of the live DB (this is your seed + rollback point):
   ```bash
   ./backup.sh                       # writes backups/YYYY/MM/YYYY-MM-DD.sql.gz
   ```
3. **Generate the new secrets** now and keep them somewhere safe (NOT in git):
   ```bash
   openssl rand -hex 24      # → new API_KEY
   openssl rand -base64 24   # → new DB password
   ```
   (Do **not** rotate the Android **keystore/signing** password — changing the signing
   key breaks app updates for existing installs. Only the API key + DB password rotate
   here. See §6.)

---

## 3. Database on the VPS (with the new password)

```bash
sudo mysql
```
```sql
CREATE DATABASE wildwatch_nestcheck CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wildwatch_nestcheck_api'@'localhost' IDENTIFIED BY '<NEW-DB-PASSWORD>';
GRANT ALL PRIVILEGES ON wildwatch_nestcheck.* TO 'wildwatch_nestcheck_api'@'localhost';
FLUSH PRIVILEGES;
```

Restore the latest backup dump (schema **and** data — do **not** use
`database_schema.sql`, it has drifted):

```bash
scp backups/2026/06/2026-06-30.sql.gz  user@vps:/tmp/
ssh user@vps 'gunzip < /tmp/2026-06-30.sql.gz | mysql -u root -p wildwatch_nestcheck'
```

---

## 4. Deploy the code to the VPS

Assume the docroot is `/var/www/wildwatch/` (adjust to taste).

### 4.1 Build the SPA (on your dev machine)
```bash
cd wildwatch_web/wildwatch && npm install && npx vite build   # → dist/
```

### 4.2 Upload the frontend
```bash
rsync -av --delete wildwatch_web/wildwatch/dist/  user@vps:/var/www/wildwatch/
```
This includes `index.html`, `assets/`, and the static files (`favicon.svg`,
`icons.svg`, `manifest.json`, `appicon.png`, `loading-bg.webp`) — unlike
`deploy-web.sh`, rsync of the whole `dist/` ships them all.

### 4.3 Upload the PHP API
```bash
rsync -av --include='*.php' --exclude='*' wildwatch_web/  user@vps:/var/www/wildwatch/penguin-api/
```

### 4.4 The `/api` alias (critical)
The SPA fetches relative `/api/...`; the PHP lives in `penguin-api/`. Make `/api` resolve:
```bash
ssh user@vps 'cd /var/www/wildwatch && ln -s penguin-api api'
```

### 4.5 `config.php` with the NEW credentials
On the VPS, create the (git-ignored) real config from the template and fill in the
**new** DB password + **new** API key:
```bash
ssh user@vps
cp /var/www/wildwatch/penguin-api/config.php.sample /var/www/wildwatch/penguin-api/config.php
# edit: DB_PASS=<NEW-DB-PASSWORD>, API_KEY=<NEW-API_KEY>; DB_HOST=localhost
```
(The repo no longer ships a real `config.php` — only `config.php.sample`.)

### 4.6 `.htaccess`
Copy `wildwatch_web/.htaccess` to the docroot (`/var/www/wildwatch/.htaccess`). It
forces HTTPS and does the SPA fallback (serve `index.html`, except real files and
`/api/`). Ensure Apache has `AllowOverride All` for the docroot so `.htaccess` is read.

> **nginx instead of Apache?** There's no `.htaccess`; put the equivalent in the server
> block: force HTTPS, `location /api/ { … fastcgi to php-fpm … }`, and
> `try_files $uri $uri/ /index.html;` for the SPA fallback.

---

## 5. TLS, test, and DNS cutover

1. **Apache vhost** for `wildwatch.co.nz` pointing at `/var/www/wildwatch`, then:
   ```bash
   sudo certbot --apache -d wildwatch.co.nz -d www.wildwatch.co.nz
   ```
2. **Test before DNS** — from your machine, pin the host:
   ```bash
   curl --resolve wildwatch.co.nz:443:<VPS-IP> https://wildwatch.co.nz/ -I
   curl --resolve wildwatch.co.nz:443:<VPS-IP> -H "X-API-Key: <NEW-API_KEY>" \
        https://wildwatch.co.nz/api/backup.php -o /tmp/t.sql.gz -w '%{http_code}\n'
   ```
   Confirm the SPA loads, `/api/snapshot.php` returns data with a valid session, and a
   test write persists.
3. **Cutover:** point the `wildwatch.co.nz` A record at the VPS IP. Watch both hosts;
   keep the old one running until the VPS is confirmed good (low TTL makes rollback a
   DNS revert).

---

## 6. Finish the key rotation (after the VPS is serving)

The new `API_KEY` only takes full effect once every client/consumer uses it. Update
these, in this order, to avoid a window where something 401s:

1. **VPS `config.php`** — already has the new key/password (§4.5). ✅ (the server is the source of truth.)
2. **`.env` on the build machine and on devian** — set the new `API_KEY`:
   ```bash
   # on each machine, edit repo-root .env
   API_KEY=<NEW-API_KEY>
   ```
   (Also point any `backup.sh`/cron at the new host if the domain or path changed.)
3. **nestcheck** (`nestcheck/secrets.props` → `<BoxTagsApiKey>`) — set the new key,
   **rebuild and redeploy** the Android app. Until users update, old builds keep using
   the old key — so **keep the old key working on the server during the transition**
   (see note below), or accept that old app installs lose API access until updated.
4. **Cron URLs** that pass the key inline (`disk_history.php?cron=<API_KEY>` in
   `scripts/wildwatch-disk-alert.sh`) — these read from `.env`, so step 2 covers them.

> **Transitional dual-key (optional, recommended if field devices are in use):** the
> API supports a global `API_KEY` *and* per-observer `api_key`s (see
> `requireReadAuth`). To avoid bricking old nestcheck installs the moment you rotate,
> you can issue the new global key on the VPS but **also** add the *old* key as a
> per-observer `api_key` row temporarily, then remove it once all field devices are
> updated.

> **Do NOT rotate the Android keystore/signing password** as part of this. It signs the
> app; changing it stops existing installs from updating. It's a separate, deliberate
> operation (and only safe with Play App Signing). Leave `KeystorePassword` /
> `SigningKeyPassword` as-is.

---

## 7. Decommission & cleanup

1. Leave the old cPanel host read-only for a few days as a fallback.
2. Once the VPS is proven: take a final backup from the VPS, then **tear down the old
   host** (or at least revoke its DB user and delete the old `config.php`).
3. The **old DB password and old `API_KEY` are now dead** — their presence in git
   history no longer matters, which is the point of rotating during the move.
4. (Optional) still scrub git history with `git filter-repo` if you want the old values
   gone from GitHub entirely — but it's no longer a live exposure once rotated.

---

## 8. Cutover checklist

- [ ] VPS provisioned (PHP 8 + php-fpm, MariaDB, Apache+rewrite, certbot)
- [ ] New `API_KEY` and new DB password generated and stored safely
- [ ] DB + user created with **new** password; latest backup restored
- [ ] SPA built and rsynced to docroot (incl. static files)
- [ ] PHP rsynced to `penguin-api/`; `api → penguin-api` symlink created
- [ ] `config.php` created from sample with **new** DB pass + **new** API key
- [ ] `.htaccess` in place; `AllowOverride All`; HTTPS redirect works
- [ ] TLS issued via certbot
- [ ] Verified via `--resolve` before DNS: SPA loads, `/api` reads + writes, backup downloads
- [ ] DNS A record cut over (low TTL)
- [ ] `.env` updated (new key) on build machine **and** devian; crons repointed
- [ ] nestcheck rebuilt with new key (with transitional dual-key if field devices live)
- [ ] Old host decommissioned; old secrets dead
