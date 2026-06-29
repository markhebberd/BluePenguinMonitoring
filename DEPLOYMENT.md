# Wildwatch — Deployment & Server Migration

How the **wildwatch** web app (wildwatch.co.nz) is built, deployed, and what it
takes to move it to a new server. (The **nestcheck** Android app is separate and
not covered here — it only talks to this server's API over HTTPS.)

---

## 1. Architecture

Three pieces, all served from one web host:

| Piece | What it is | Lives on server at |
|---|---|---|
| **Frontend** | Vite/React SPA (built to static files) | `public_html/` (the `dist/` output: `index.html`, `assets/`, icons) |
| **API** | Plain PHP scripts (no framework) | `public_html/penguin-api/` |
| **Database** | MySQL/MariaDB | `DB_NAME` = `wildwatch_nestcheck` (see `config.php`) |

The SPA is a static bundle; all dynamic data comes from the PHP API, which talks
to MySQL. There is no Node.js running on the server — Node is only used **locally**
to build the frontend.

### The `/api/` ↔ `/penguin-api/` alias (critical)

The built frontend calls the API with the **relative path `/api/...`** (e.g.
`fetch('/api/snapshot.php')` — see `wildwatch/src/api/*.ts`). But the PHP files are
deployed to `public_html/penguin-api/`. On the current server **both `/api/` and
`/penguin-api/` resolve to the same PHP directory** (the app uses `/api/`,
`backup.sh` and ops scripts use `/penguin-api/`).

**On a new server you MUST make the PHP reachable at `/api/`**, or the app gets 404s
on every request. Easiest: a symlink in the web root —

```bash
cd public_html && ln -s penguin-api api
```

(Or an Apache `Alias /api /…/penguin-api`, or just deploy the PHP into
`public_html/api/` instead and keep a `penguin-api` symlink for the ops scripts.)

---

## 2. Server requirements

- **PHP 7.4+ or 8.x** with PDO MySQL (`pdo_mysql`), `getallheaders()`, `mail()`.
- **MySQL 5.7+ / MariaDB 10.3+**, utf8mb4.
- **Apache with `mod_rewrite`** (for the HTTPS redirect + SPA fallback in `.htaccess`).
- **HTTPS / valid TLS cert** — `.htaccess` force-redirects all HTTP to HTTPS.
- **A real local mailbox** for outbound alerts (disk-space warnings). Current sender
  is `mark@wildwatch.co.nz` — `mail()` drops mail from a non-existent `From:`.
- **Local build machine** with **Node 20+** and npm (to build the SPA; not needed on the server).

---

## 3. Secrets & configuration

### `wildwatch_web/config.php` — git-ignored, contains live DB credentials
Holds the **DB credentials** (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`) and the
shared **`API_KEY`**. **No longer tracked in git** — the real file lives only on the
dev/build machines and on the server. The repo ships **`config.php.sample`** (same
file with the secret values replaced by `CHANGE_ME_*`).

**On a fresh machine or migration:** copy the sample and fill in real values —
```bash
cp wildwatch_web/config.php.sample wildwatch_web/config.php   # then edit DB_PASS, API_KEY
```
`deploy-web.sh` globs `wildwatch_web/*.php`, so the local (untracked) `config.php`
still uploads on deploy; the `.sample` does not (it doesn't end in `.php`).

> **Note:** the secrets were tracked historically, so they still exist in **git
> history and on GitHub**. Removing them from `HEAD` does not erase that — the only
> complete remediation is to **rotate** `DB_PASS` and `API_KEY` (and optionally
> rewrite history with `git filter-repo` + force-push, which would require re-cloning
> on every other machine).

### `.env` (repo root) — git-ignored, deploy + cron credentials
```
FTP_USER=<cPanel username>
FTP_PASS=<cPanel password>
API_KEY=<shared API key, same value as config.php's API_KEY>
```
Used by `deploy-web.sh` (FTP creds), `backup.sh`, and `scripts/wildwatch-disk-alert.sh`
(API key). **Recreate this on every machine that deploys or runs the cron jobs** — i.e.
the build machine *and* devian. The cron scripts fail loudly (`API_KEY not set`) if it's
missing rather than running with a stale key.

---

## 4. Build & deploy

The canonical path is **`deploy-web.sh`** (repo root). It:

1. Lints for unstyled `<a>` tags (fails the deploy if found).
2. Builds the SPA: `npx vite build` in `wildwatch_web/wildwatch/` → `dist/`.
3. Uploads `dist/index.html` + `dist/assets/*` to `public_html/` via the **cPanel
   UAPI** (`/execute/Fileman/save_file_content` on port 2083, auth from `.env`).
4. Uploads every `wildwatch_web/*.php` to `public_html/penguin-api/`.

```bash
# one-time, on the build machine:
cd wildwatch_web/wildwatch && npm install

# each deploy, from repo root:
./deploy-web.sh
```

> **`deploy-web.sh` is cPanel-specific.** It speaks cPanel's file-manager API over
> port 2083. On a **non-cPanel** server, replace steps 3–4 with `rsync`/`scp`/SFTP,
> e.g.:
> ```bash
> cd wildwatch_web/wildwatch && npx vite build
> rsync -av dist/ user@newhost:/var/www/html/
> rsync -av --include='*.php' --exclude='*' ../  user@newhost:/var/www/html/penguin-api/
> ```
> Keep the lint + build steps; only the transport changes.

> **`deploy-web.sh` only uploads `index.html` + `assets/*`.** The other static files
> (`favicon.svg`, `icons.svg`, `manifest.json`, `appicon.png`, `loading-bg.webp`) live
> in `wildwatch/public/`, are emitted into `dist/` by the build, but are **not** pushed
> by the routine deploy (they rarely change, so they're uploaded once). On a **fresh
> server you must upload these manually** into `public_html/`, or the icons/loading
> screen 404.

---

## 5. Database setup

### Preferred: restore from a backup dump
**Do not rebuild the schema from `database_schema.sql` — it has drifted** from
production (it still lists dropped/renamed columns). The accurate, complete way to
reproduce the live database is to restore the most recent backup, which is a full
`mysqldump` (schema + data):

```bash
# newest backup lives under backups/YYYY/MM/ (see §6)
gunzip < backups/2026/06/2026-06-29.sql.gz | mysql -u <user> -p <DB_NAME>
```

Create the database and user first, then point `config.php` at them:
```sql
CREATE DATABASE wildwatch_nestcheck CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wildwatch_nestcheck_api'@'localhost' IDENTIFIED BY '<new-password>';
GRANT ALL PRIVILEGES ON wildwatch_nestcheck.* TO 'wildwatch_nestcheck_api'@'localhost';
```

### Migrations
Schema changes are tracked in `wildwatch_web/migrations/*.sql` (a historical record).
One-off migration runner scripts (`migrate_*.php`) are intentionally **not** kept in
the repo or on the server — they were applied once and removed. If you restore from a
recent dump you already have the latest schema; the `migrations/` files are reference
only.

---

## 6. Scheduled jobs (cron)

| Job | Schedule | What | Where it runs |
|---|---|---|---|
| **DB backup** | `0 6 * * *` (daily 06:00) | `backup.sh` pulls a gzipped `mysqldump` from `/api/backup.php` to `backups/YYYY/MM/YYYY-MM-DD.sql.gz` | the **deviain** box (`mark@devian`), not the web host |
| **Disk sample** | every 15 min | `disk_check.php` records free space, emails a warning under 50 GB | web host cron → hits the script |
| **Disk descent** | per `disk_history.php` | descent-detection alert | web host cron, URL form `…/penguin-api/disk_history.php?cron=<API_KEY>` |

Notes:
- `backup.sh` authenticates with `X-API-Key` (the `API_KEY` from `config.php`) and
  hits `https://<host>/api/backup.php`. The endpoint uses `requireReadAuth` (API key
  on GET), **not** the session-only `requireAuth`. (A past key mismatch silently
  failed backups for ~5 days — watch for `401`s in `backups/backup.log`.)
- Alert email recipients/sender are hard-coded in `disk_check.php`.
- On migration, recreate these crons on the new host (and update the `mark@devian`
  backup cron's target URL if the domain changes).

---

## 7. Routing — `.htaccess`

`public_html/.htaccess` (source: `wildwatch_web/.htaccess`):
```apache
RewriteEngine On
# force HTTPS
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
# SPA fallback: serve index.html for client-side routes, except real files/dirs and /api/
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteCond %{REQUEST_URI} !^/api/
RewriteRule ^(.*)$ /index.html [L]
```
The SPA uses client-side routing (`/box/…`, `/bird/…`, `/reports`, `/day/…`), so any
unknown path must serve `index.html`. The `!^/api/` exclusion keeps API calls from
being swallowed by the SPA fallback — which is why `/api/` must point at real PHP.

---

## 8. Migration checklist (move to a new server)

1. **Provision** host with PHP 8.x + `pdo_mysql`, MySQL 8, Apache + `mod_rewrite`, TLS.
2. **DB:** create database + user; restore the newest `backups/…/*.sql.gz` dump (§5).
3. **Config:** edit `config.php` with the new DB creds; **rotate `API_KEY`**.
4. **Build & upload:** `npm install` then build; place `dist/*` in `public_html/`,
   `*.php` in `public_html/penguin-api/`.
5. **Alias:** `cd public_html && ln -s penguin-api api` (so `/api/` works). §1.
6. **.htaccess:** install at web root; confirm HTTPS redirect + SPA fallback work.
7. **Mailbox:** create the alert sender mailbox (`mark@<domain>` or update `disk_check.php`).
8. **Crons:** recreate disk_check / disk_history crons on the host; repoint the daily
   `backup.sh` cron (on deviain or wherever) at the new domain.
9. **DNS:** point the domain at the new host once verified.
10. **Smoke test:** load the site (SPA paints), confirm `/api/snapshot.php` returns
    data with a valid session, place a test write, and run `./backup.sh` to confirm a
    dump downloads (HTTP 200, file > 1 KB).

---

## 9. Quick reference

- Build dir: `wildwatch_web/wildwatch/` · output `dist/`
- Deploy script: `deploy-web.sh` (cPanel) · Backup script: `backup.sh`
- API source: `wildwatch_web/*.php` → server `public_html/penguin-api/` (alias `/api`)
- DB: `wildwatch_nestcheck` (creds + `API_KEY` in `config.php`)
- Schema of record: **latest backup dump**, not `database_schema.sql` (drifted)
- Secrets to rotate on migration: `DB_PASS`, `API_KEY`, cPanel `.env`
