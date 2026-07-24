# Wildwatch NAS mirror

A LAN-only, plain-HTTP copy of Wildwatch running on a Synology NAS, rebuilt every night
from that night's backup. It does two jobs at once:

1. **Backup destination** — pulls `https://wildwatch.co.nz/api/backup.php` nightly and keeps
   every dump forever under `backups/YYYY/MM/YYYY-MM-DD.sql.gz`. Nothing is ever pruned.
2. **Proof the backup restores** — wipes a database, restores that dump into it *from empty*,
   verifies it, and only then points the site at it. If you can browse the colony at
   `http://<nas-ip>:8080`, the backup is provably good — not "the file was 680 KB and exited 0".

A backup you have never restored is a hypothesis. This turns it into a nightly test.

## Verified before writing this

Run locally against the real `2026-06-30` production dump:

| Check | Result |
|---|---|
| Dump restores into an **empty** MariaDB 11.8 (same version as prod) | 14 tables, **38,722** observations, 1,005 penguins, 14,161 scans — in **<1 s** |
| MariaDB-only syntax in the dump (`CHECK (json_valid(...))`, latin1/utf8mb4_general collations) | restores clean |
| SPA served from `dist/` | `GET /` → 200 |
| Client-side route (no server-side route table) | `GET /day/2026-06-30` → 200 |
| API unauthenticated | `GET /api/snapshot.php` → **401** (up, demanding a login) |
| API with a key | `GET /api/colonies.php` → 200 |
| `secrets.php` symlink into the mounted `shared/` dir | resolves inside the container |

## Layout on the NAS

```
/volume1/wildwatch/
├── nas-mirror/          <- this directory (docker-compose.yml, Dockerfile, .env)
├── app/                 <- SPA dist at the root, PHP API in app/api/  (rsynced from the Mac)
├── shared/
│   ├── secrets.php      <- DB credentials; app/api/secrets.php is a symlink to this
│   ├── active_db        <- "ww_a" or "ww_b" — which restore slot is live
│   └── nas.env          <- WW_API_KEY (production read key), chmod 600 root
├── backups/YYYY/MM/     <- the archive. Never pruned.
├── status/index.html    <- nightly report, served at /status/
├── logs/nightly.log
└── bin/nightly.sh
```

Two database slots (`ww_a`, `ww_b`) alternate. Each night the **inactive** one is dropped,
recreated empty, restored and checked; the live slot only flips once the checks pass. A bad
night therefore leaves yesterday's good copy serving, and never blanks the site.

## Requirements

- A Synology that can run **Container Manager** (DSM 7.2+, x86_64 or arm64 — most Plus/Value
  models; not the older ARMv7 boxes). Non-Docker fallback below.
- ~1 GB of disk for the app + database. The archive grows at **~680 KB/night ≈ 250 MB/year**,
  so "forever" is genuinely fine.
- Outbound HTTPS from the NAS. **No port forward, no reverse-proxy entry, no QuickConnect rule.**

## Setup

**1. Build the SPA on the Mac** (I don't run builds — this is yours to run):

```bash
cd ~/src/penguins/wildwatch_web/wildwatch && npx vite build
```

**2. Copy the app tree to the NAS** (SSH enabled in DSM → Terminal & SNMP):

```bash
NAS=admin@192.168.1.109
ssh $NAS 'mkdir -p /volume1/wildwatch/{app/api,shared,backups,status,logs,bin,tmp}'
cd ~/src/penguins/wildwatch_web
rsync -av --exclude .htaccess wildwatch/dist/ $NAS:/volume1/wildwatch/app/
rsync -av --exclude secrets.php --exclude 'secrets.php.sample' \
      --include '*.php' --include 'migrations/***' --exclude '*' \
      ./ $NAS:/volume1/wildwatch/app/api/
rsync -av nas-mirror/ $NAS:/volume1/wildwatch/nas-mirror/
scp nas-mirror/bin/nightly.sh $NAS:/volume1/wildwatch/bin/
```

> **Do not copy `wildwatch_web/.htaccess`.** It force-redirects HTTP→HTTPS, which would break
> a plain-HTTP LAN site instantly. The rsync above excludes it; `apache-site.conf` sets
> `AllowOverride None` as a second line of defence.

**3. On the NAS**, as root (SSH, `sudo -i`):

```bash
cd /volume1/wildwatch
cp nas-mirror/env.sample nas-mirror/.env          # set BIND_ADDR, HTTP_PORT, both passwords
cp nas-mirror/secrets.php.nas shared/secrets.php  # DB_PASS must match DB_APP_PASS
ln -sfn /var/www/shared/secrets.php app/api/secrets.php   # dangling on the host, valid in the container
printf 'WW_API_KEY=<production API key>\n' > shared/nas.env
chmod 600 shared/nas.env nas-mirror/.env; chmod 640 shared/secrets.php
chmod +x bin/nightly.sh
docker compose -f nas-mirror/docker-compose.yml --env-file nas-mirror/.env up -d --build
```

**4. First run:** `/volume1/wildwatch/bin/nightly.sh` — takes a few seconds, prints each step.

**5. DSM → Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
- User: **root**, daily at **03:30** (production's own backup cron runs 03:15 UTC — pick a time
  after wildwatch.co.nz has finished its own night's work)
- Command: `/volume1/wildwatch/bin/nightly.sh`
- Tick **"Send run details by email"** and **"only when the script terminates abnormally"** —
  that's the failure alarm, and it costs nothing.

## What she sees

- `http://192.168.1.109:8080/status/` — last night's report: downloaded, archived, restored into
  an empty database, row counts (with last night's for comparison), latest observation date,
  and a green **RESTORE VERIFIED** / red **RESTORE FAILED** badge.
- `http://192.168.1.109:8080/` — Wildwatch itself, her normal login (the observer accounts and
  password hashes come out of the restored backup, so logging in is *itself* part of the proof).

Anything she edits there vanishes at 03:30 when the slot is rebuilt. The status page says so.

## Two things to decide before you hand her the API key

**1. `backup.php` dumps the entire database — all colonies, all observers.** Not just hers. Once
this runs, her NAS holds every colony's observations plus every observer's email and password
hash, forever, on hardware you don't control. Options:

- Accept it (she's already a trusted admin) — simplest, and the honest default if she's effectively
  a co-owner of the data.
- Give the NAS its **own** key rather than the shared `API_KEY`: `requireReadAuth()` in
  [config.php:175-177](../config.php#L175-L177) also accepts a per-observer `api_key`, so
  `UPDATE observers SET api_key='<new>' WHERE observer_id=<nas-service-account>` gives you a key
  you can revoke on its own without rotating everything else. Recommended either way.
- Sanitise after restore: `UPDATE observers SET password_hash='!disabled', email=NULL` in the
  restored slot — but then she can't log in, which removes the best part of the proof.
- Encrypt the archive at rest (`age -r <your pubkey>`) after restoring, so the forever-archive is
  unreadable on her NAS while the live mirror still works. Add ~3 lines to `nightly.sh` if you want it.

**2. The key is a read key for production.** On the NAS it must stay in `shared/nas.env`,
`chmod 600`, root-owned — not in the Task Scheduler command line, which DSM logs in plain text.

## Keeping it in sync with production

The nightly dump carries production's *schema*, so the database always matches prod. The only
thing that can drift is the NAS's copy of the app code, and the status page shows its date.

Old code + new schema is harmless (it ignores columns it doesn't know about). The one bad
combination is **new code + old schema** — I hit exactly that while testing: today's
`colonies.php` against the June 30 dump gives `Unknown column 'c.colony_prefix'`, because that
column landed in a later migration. So: after a deploy that includes a migration, rsync the app
tree *and then* re-run `nightly.sh`, rather than rsyncing and waiting.

## Fallback if the NAS can't run Docker

Older/value models without Container Manager can do this with DSM packages instead — **Web
Station** (Apache + PHP 8.x profile with `pdo_mysql` enabled), **MariaDB 10/11**, and the same
`nightly.sh` with the `docker exec` lines replaced by `/usr/local/mariadb11/bin/mysql`. Same
design, more DSM GUI fiddling, and Web Station's virtual host does the SPA fallback rewrite.
Tell me the model and I'll write that variant.
