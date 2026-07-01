# Migration runbook — Wildwatch → tantrixlab VPS (nginx co-hosting)

Move **wildwatch.co.nz** off the cPanel shared host and **co-host it on the existing
tantrixlab VPS**, served by the **nginx already running there** — *not* a fresh box and
*not* Caddy. Rotate the DB password + `API_KEY` during cutover (both lived in git
history → treat as compromised).

This reconciles the two generic runbooks against the box **as actually built**:
- `MIGRATION-HETZNER-CADDY.md` — assumes a *fresh, dedicated* VPS + Caddy. **Don't use
  it here:** Caddy would collide with nginx on :80/:443 and force migrating the working
  tantrix site too.
- `MIGRATION-TANTRIXLAB-VPS.md` — right target, but defaults to Apache. We use its
  **nginx path**.
- **Read `DEPLOYMENT.md` first** for architecture (static SPA + PHP API + MySQL), the
  `/api` ↔ `/penguin-api` alias, and where every secret lives. Not repeated here.

---

## 0. The box as-built (verified 2026-07-01)

| | Value |
|---|---|
| Host | Hetzner `debian-4gb-hel1-2`, `204.168.139.151` = tantrixlab.com |
| OS | Debian 13 (trixie), 2 vCPU / 3.7 GB / 38 GB |
| Web server | **nginx** on :80/:443 (serves tantrixlab.com) — *add a vhost, don't replace* |
| TLS | **certbot 4.0 + nginx plugin already installed**, renewal timer active — reuse |
| DB | **MariaDB 11.8.6** on `localhost:3306` (tantrix_online, user `mark`) — add a db + user |
| PHP | **none yet** — install php-fpm (Debian 13 candidate = **PHP 8.4**, socket `/run/php/php8.4-fpm.sock`) |
| Node backend | tantrix `:3001` via pm2 (untouched by this) |
| Login | `ssh tantrixlab` → user **`mark`**, passwordless sudo, root login disabled |

**What's new vs. just-add-a-vhost:** only **php-fpm** is a genuinely new component.
nginx, TLS tooling, and MariaDB are already here.

> ⚠️ **Two gaps found on this box, fix as part of this work (see §8):**
> 1. **No firewall rules visible** (`ufw` absent; only the Hetzner Cloud Firewall, if
>    any, is in front). Confirm only 22/80/443 are public.
> 2. **No DB backups exist at all** — not even for tantrix. The legacy backup routine
>    targeted the old `192.168.19.5`. Set up real backups here.

---

## 1. Install PHP-FPM (the one new component)

```bash
sudo apt update
sudo apt install -y php-fpm php-mysql php-mbstring php-xml php-curl
ls /run/php/                       # confirm socket name → expect php8.4-fpm.sock
sudo systemctl enable --now php8.4-fpm
```

Requirements recap (DEPLOYMENT.md): PHP 8.x with `pdo_mysql`, `getallheaders()`,
`mail()` optional. nginx already has everything else.

### Recommended: a dedicated php-fpm pool + system user (isolation)

Rather than running wildwatch's PHP as the shared `www-data`, give it its own pool user
so a wildwatch compromise can't touch anything else. Create
`/etc/php/8.4/fpm/pool.d/wildwatch.conf`:

```ini
[wildwatch]
user = wildwatch
group = wildwatch
listen = /run/php/wildwatch.sock
listen.owner = www-data        ; nginx connects to the socket
listen.group = www-data
; dynamic (not ondemand) keeps a couple of workers warm → lower first-request latency
pm = dynamic
pm.max_children = 8
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 500
php_admin_value[upload_max_filesize] = 10M
php_admin_value[post_max_size] = 10M
```

```bash
sudo useradd -r -s /usr/sbin/nologin wildwatch
sudo systemctl restart php8.4-fpm
```

The nginx vhost (§5) then points at `unix:/run/php/wildwatch.sock`, and `secrets.php` is
owned `wildwatch:wildwatch` mode `600` — readable only by the PHP worker, not by
`www-data`, `mark`, or any other service. (If you'd rather keep it simple, the default
`www-data` pool + socket `/run/php/php8.4-fpm.sock` works too; just `chgrp www-data
secrets.php` mode 640.) OPcache is on by default in the FPM SAPI — no extra config needed.

> **The app writes into its own directory** (cPanel-style): the Disk Write Test streams
> to `penguin-api/disk_test.tmp`, and the disk-alert throttle writes
> `penguin-api/disk_alert_last.txt`. So `penguin-api/` must be owned by the pool user
> (`wildwatch`), not the deploy user — `deploy.sh` §6 chowns it after each rsync. If PHP
> ran as a user that couldn't write its own dir, the Disk Write Test 500s.

---

## 2. Pre-migration prep (before touching DNS)

1. **Lower DNS TTL** for `wildwatch.co.nz` to **300s** a day ahead — fast, reversible cutover.
2. **Fresh backup** of the live cPanel DB (seed + rollback point):
   ```bash
   ./backup.sh        # writes backups/YYYY/MM/YYYY-MM-DD.sql.gz
   ```
3. **Generate new secrets** now; store in your password manager (NOT git):
   ```bash
   openssl rand -hex 24      # → new API_KEY
   openssl rand -base64 24   # → new DB password
   ```
   Do **not** touch the Android keystore/signing password (see §7).

---

## 3. Database (dedicated user — do NOT reuse `mark`)

Reuse the running MariaDB instance, but give wildwatch its **own** database and user.
Reusing the tantrix `mark` DB user would put a tantrix-capable credential inside
wildwatch's internet-facing `secrets.php` — exactly the coupling we're rotating away
from. Two databases, two users, one instance, fully isolated.

```bash
ssh tantrixlab
sudo mysql      # root via unix socket
```
```sql
CREATE DATABASE wildwatch_nestcheck CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wildwatch_nestcheck_api'@'localhost' IDENTIFIED BY '<NEW-DB-PASSWORD>';
GRANT ALL PRIVILEGES ON wildwatch_nestcheck.* TO 'wildwatch_nestcheck_api'@'localhost';
FLUSH PRIVILEGES;
```

Restore the **latest backup dump** (schema **and** data — *not* `database_schema.sql`,
it has drifted from production):

```bash
scp backups/2026/07/<newest>.sql.gz  tantrixlab:/tmp/
ssh tantrixlab 'gunzip < /tmp/<newest>.sql.gz | sudo mysql wildwatch_nestcheck && rm /tmp/<newest>.sql.gz'
```

---

## 4. Layout & deploy (improved — see §6 for the full strategy)

Use an **atomic release layout** instead of rsyncing straight into a live docroot:

```
/var/www/wildwatch/
  releases/<timestamp>/      each deploy = a fresh dir (SPA dist + penguin-api/)
  shared/secrets.php         created once, never touched by a deploy
  current -> releases/<timestamp>    nginx & php-fpm read through this symlink
```

One-time setup:
```bash
ssh tantrixlab
sudo mkdir -p /var/www/wildwatch/{releases,shared}
sudo chown -R mark:mark /var/www/wildwatch        # mark owns the tree for rsync deploys
```

`secrets.php` lives in `shared/` (created from `secrets.php.sample` with the **new** DB
pass + **new** API key), symlinked into each release so deploys can never clobber it:
```bash
cp .../secrets.php.sample /var/www/wildwatch/shared/secrets.php
# edit: DB_HOST=localhost, DB_NAME=wildwatch_nestcheck,
#       DB_USER=wildwatch_nestcheck_api, DB_PASS=<NEW>, API_KEY=<NEW>
sudo chown wildwatch:wildwatch /var/www/wildwatch/shared/secrets.php   # pool user from §1
sudo chmod 600 /var/www/wildwatch/shared/secrets.php
```

The `/api` alias still applies (SPA fetches relative `/api/...`, PHP lives in
`penguin-api/`): the release script creates `current/api -> penguin-api` and
`current/penguin-api/secrets.php -> ../../shared/secrets.php`. See the deploy script in §6.

---

## 5. nginx vhost + TLS

Create `/etc/nginx/sites-available/wildwatch.co.nz`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name wildwatch.co.nz www.wildwatch.co.nz;
    # certbot will add the 80→443 redirect when it installs the cert
    root /var/www/wildwatch/current;
    index index.html;

    client_max_body_size 10M;

    # Run ONLY real .php files through php-fpm. Scoping to *.php (not a catch-all
    # index.php router) is what lets unknown SPA routes fall through to index.html.
    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/wildwatch.sock;   # or php8.4-fpm.sock if using default pool
    }

    # SPA fallback: real file (assets, icons, /api/*.php) → serve it; else index.html.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # backup.php streams a gzipped mysqldump — allow long responses.
    location = /api/backup.php {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/wildwatch.sock;
        fastcgi_read_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wildwatch.co.nz /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d wildwatch.co.nz -d www.wildwatch.co.nz   # reuses existing certbot
```

certbot rewrites the vhost to add `listen 443 ssl`, the cert paths, and the HTTP→HTTPS
redirect, and the existing renewal timer covers it. A **public** cert only issues once
DNS points here (§ cutover), so test first with `--resolve` (below).

> **Auth headers:** the API reads `$_SERVER['HTTP_AUTHORIZATION']` (Bearer) and
> `getallheaders()['X-API-Key']`. `snippets/fastcgi-php.conf` + php-fpm forward both;
> `getallheaders()` works under php-fpm. Still verify in the smoke test.

### Test before DNS

```bash
curl --resolve wildwatch.co.nz:443:204.168.139.151 https://wildwatch.co.nz/ -I
curl --resolve wildwatch.co.nz:443:204.168.139.151 -H "X-API-Key: <NEW-API_KEY>" \
     https://wildwatch.co.nz/api/backup.php -o /tmp/t.sql.gz -w '%{http_code}\n'
```
Confirm: SPA paints; an SPA route (`/box/1`) returns `index.html`; `/api/snapshot.php`
returns data with a valid session; **a test write persists**; backup downloads (200, >1 KB);
**Bearer login works**. (Before the real cert exists, certbot will have issued one only
post-DNS — for the pre-DNS test either accept the staging/self-signed cert with `curl -k`
or use the throwaway-subdomain trick from the Caddy doc §6.)

### Cutover
Point `wildwatch.co.nz` + `www` **A records at `204.168.139.151`**. Keep the old cPanel
host running; low TTL makes rollback a one-line DNS revert.

---

## 6. Deploy strategy (rethought, now that we're off cPanel)

cPanel forced `deploy-web.sh` to push files through the UAPI (port 2083) — no shell, no
symlinks, partial uploads, icons uploaded once by hand. With full SSH we can do much
better. **Keep** the script's lint (`grep` for unstyled `<a>`) + `vite build`; **replace**
the upload.

**Improvements adopted:**

1. **Atomic releases + symlink flip** (§4 layout). Deploy into a *new* `releases/<ts>/`,
   then repoint `current` — the switch is one atomic `ln -sfn`. No half-updated docroot,
   and **rollback = point `current` at the previous release** (instant).
2. **`secrets.php` in `shared/`**, symlinked in — deploys can `rsync --delete` freely and
   never risk the secret; config is decoupled from code.
3. **Build off-box.** The SPA is built in CI/dev; the VPS only receives `dist/` + PHP.
   No Node toolchain needed on the VPS for wildwatch (smaller surface). PHP isn't compiled.
4. **`rsync --link-dest` against the previous release** — unchanged files hardlink, so each
   release costs only the changed bytes and transfers are minimal.
5. **Smoke test + auto-rollback** baked into the release flip.

`deploy.sh` (run from your dev machine):

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST=tantrixlab
BASE=/var/www/wildwatch
TS=$(date +%Y%m%d-%H%M%S)
REL="$BASE/releases/$TS"

# 1. lint + build (kept from deploy-web.sh)
grep -rn '<a ' wildwatch_web/wildwatch/src && echo "unstyled <a> — fix first" >&2 || true
( cd wildwatch_web/wildwatch && npm ci && npx vite build )

# 2. stage release dir on the VPS, hardlinking unchanged files from the live release
ssh "$HOST" "mkdir -p '$REL' && cp -al '$BASE/current/.' '$REL/' 2>/dev/null || true"

# 3. ship SPA + PHP into the new release
rsync -a --delete            wildwatch_web/wildwatch/dist/  "$HOST:$REL/"
rsync -a --include='*.php' --include='*/' --exclude='*' \
                              wildwatch_web/               "$HOST:$REL/penguin-api/"

# 4. wire aliases + shared secrets, then flip atomically
ssh "$HOST" bash -s <<EOF
set -e
ln -sfn penguin-api "$REL/api"
ln -sfn "$BASE/shared/secrets.php" "$REL/penguin-api/secrets.php"
# The PHP app writes into its own dir (disk_test.tmp write-test, disk_alert_last.txt
# throttle state — cPanel-style). rsync lands it as \$USER; hand penguin-api to the
# wildwatch pool user so those writes work. Without this the Disk Write Test 500s.
sudo chown -R wildwatch:wildwatch "$REL/penguin-api"
ln -sfn "$REL" "$BASE/current"
# smoke test; roll back if it fails
code=\$(curl -s -o /dev/null -w '%{http_code}' --resolve wildwatch.co.nz:443:127.0.0.1 https://wildwatch.co.nz/ || echo 000)
if [ "\$code" != "200" ]; then
  prev=\$(ls -1dt "$BASE"/releases/*/ | sed -n 2p)
  ln -sfn "\${prev%/}" "$BASE/current"
  echo "smoke test failed (\$code) — rolled back to \$prev" >&2; exit 1
fi
# keep last 5 releases
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r rm -rf
echo "deployed $TS"
EOF
```

### Option: GitHub Actions (you raised this — recommended *after* the manual cutover)

Once the manual `deploy.sh` flow is proven, lifting it into CI gives push-to-deploy. Keep
the same release-flip; CI just becomes the thing that builds + rsyncs.

- **Auth:** a dedicated **deploy SSH key** (its own keypair, not your personal one), public
  half in a restricted `~/.ssh/authorized_keys` line for a `deploy` user (or `mark`),
  private half in repo **Settings → Secrets → `DEPLOY_SSH_KEY`**. Optionally lock the key
  down with `command="..."`/`restrict` so it can only run the release script.
- **Secrets stay on the box.** `secrets.php` lives in `shared/` and is never in the repo
  or CI — CI only ever ships code, never credentials. This is a real upgrade over the
  cPanel era.
- **Trigger:** `on: push: branches: [main]` for the `wildwatch_web/**` paths, plus
  `workflow_dispatch` for manual runs.

```yaml
# .github/workflows/deploy-wildwatch.yml
name: Deploy wildwatch
on:
  push: { branches: [main], paths: ['wildwatch_web/**'] }
  workflow_dispatch:
concurrency: deploy-wildwatch          # never two deploys at once
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: wildwatch_web/wildwatch/package-lock.json }
      - run: cd wildwatch_web/wildwatch && npm ci && npx vite build
      - uses: webfactory/ssh-agent@v0.9.0
        with: { ssh-private-key: ${{ secrets.DEPLOY_SSH_KEY }} }
      - run: |
          echo "204.168.139.151 tantrixlab" | sudo tee -a /etc/hosts
          ssh-keyscan tantrixlab >> ~/.ssh/known_hosts
          ./deploy.sh            # same script, CI-side build already done — or a thin remote-only variant
```

**Recommendation:** ship the migration with `deploy.sh` for tight control during cutover;
add the Actions workflow once it's stable so routine SPA changes are push-to-deploy.
GitHub Actions is a clear win here (cPanel couldn't do it at all) — the only new surface
is one scoped deploy key, and no secret ever enters CI.

---

## 7. Backups, crons & key rotation

### Backups — fix the gap (this box has none)
The cPanel-era `backup.php` (HTTP pull with `X-API-Key`) was a workaround for having no
shell. With SSH + local `mysqldump`, back up **directly** — and fold tantrix in, since it
currently has no backups either:

```cron
# /etc/cron.d/db-backups  (runs as root on the VPS)
15 3 * * * root /usr/local/bin/db-backup.sh wildwatch_nestcheck
30 3 * * * root /usr/local/bin/db-backup.sh tantrix_online
```
`db-backup.sh` = `mysqldump --single-transaction <db> | gzip > /var/backups/<db>/<date>.sql.gz`
with rotation, and (recommended) an off-box copy pulled by **devian** over SSH so a VPS
loss isn't a data loss. Keep `backup.php` working for nestcheck/manual use, but it's no
longer the primary path.

### Disk alert
The cPanel cron curled `disk_check.php` because cron was limited. Here, run the existing
`scripts/wildwatch-disk-alert.sh` **directly** from cron → devian himalaya alert. No need
to route a filesystem check through PHP/HTTP.

### Finish key rotation (order matters — avoid a 401 window)
1. **VPS `shared/secrets.php`** — new key + DB pass (§4). ✅ source of truth.
2. **`.env` on build machine + devian** — `API_KEY=<NEW>` (covers `backup.sh` + disk-alert).
3. **nestcheck** (`nestcheck/secrets.props` → `<BoxTagsApiKey>`) — set new key, **rebuild +
   redeploy** the Android app.
4. **Transitional dual-key** if field devices are live: add the **old** key as a
   per-observer `api_key` row temporarily (`requireReadAuth`), remove once all devices
   update — avoids bricking old installs at the instant of rotation.

> **Do NOT rotate the Android keystore/signing password** — it signs updates; changing it
> locks out existing installs. Only `API_KEY` + `DB_PASS` rotate here.

---

## 8. Harden the box (gaps found 2026-07-01)

- **Firewall:** no `ufw` present. Either confirm the **Hetzner Cloud Firewall** (console)
  allows only 22/80/443 inbound, or add host-level: `sudo apt install ufw && sudo ufw allow
  22,80,443/tcp && sudo ufw enable`. (tantrix `:3001` and MariaDB `:3306` already bind
  localhost-only — good — but defense in depth.)
- **Backups:** see §7 — currently zero. Highest-priority gap.
- Root SSH login already disabled; `mark` key-only with passwordless sudo. ✓

---

## 9. Cutover checklist

- [ ] php-fpm 8.4 installed; socket confirmed; (recommended) dedicated `wildwatch` pool + user
- [ ] New `API_KEY` + DB password generated, stored in password manager
- [ ] `wildwatch_nestcheck` DB + `wildwatch_nestcheck_api` user created (NOT reusing `mark`); latest dump restored
- [ ] `/var/www/wildwatch/{releases,shared,current}` layout; `shared/secrets.php` with new creds, owned by pool user, mode 600
- [ ] First release deployed via `deploy.sh`; `current` → release; `api`/`secrets.php` symlinks wired
- [ ] nginx vhost in place; `nginx -t` passes; `php_fastcgi` scoped to `*.php`; SPA `try_files … /index.html`
- [ ] Pre-DNS smoke test (`--resolve`): SPA loads, SPA route → index.html, `/api` reads **and writes**, backup downloads with new key, **Bearer login works**
- [ ] certbot cert issued post-DNS (`journalctl`/`certbot certificates`)
- [ ] DNS A records (apex + www) cut over to `204.168.139.151` (low TTL)
- [ ] Backups live (wildwatch **and** tantrix); off-box copy to devian; backup.log clean (no 401)
- [ ] Disk alert cron running directly; firewall confirmed 22/80/443 only
- [ ] `.env` updated (new key) on build machine + devian; nestcheck rebuilt (dual-key if field devices live)
- [ ] (Optional) GitHub Actions deploy workflow added once manual flow proven
- [ ] Old cPanel host decommissioned; old secrets dead

---

## 10. Quick reference

- Docroot: `/var/www/wildwatch/current` (→ `releases/<ts>`) · PHP: `current/penguin-api/` · `api → penguin-api`
- Secrets: `/var/www/wildwatch/shared/secrets.php` (symlinked into each release; never in git/CI)
- Web config: `/etc/nginx/sites-available/wildwatch.co.nz` · `nginx -t` / `systemctl reload nginx`
- PHP: php-fpm 8.4, pool socket `/run/php/wildwatch.sock` (or `php8.4-fpm.sock`)
- TLS: `certbot --nginx -d wildwatch.co.nz -d www.wildwatch.co.nz` (existing certbot + timer)
- Deploy: `deploy.sh` (build off-box → rsync to new release → atomic symlink flip → smoke test → auto-rollback); GH Actions optional
- Rotate on migration: `DB_PASS`, `API_KEY` (NOT the Android keystore)
- Don't touch: tantrix (nginx vhost, `:3001` pm2 app, `mark` DB user) — fully separate
- Architecture / `/api` rationale / schema-of-record (= latest backup): **DEPLOYMENT.md**
