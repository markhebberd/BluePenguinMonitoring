# Wildwatch NAS mirror

A complete third copy of Wildwatch on a Synology NAS, at a second physical site, that rebuilds
itself every night and serves the result on the LAN. It does three jobs:

1. **Backup destination** — pulls `https://wildwatch.co.nz/api/backup.php` nightly and keeps
   every dump forever under `backups/YYYY/MM/YYYY-MM-DD.sql.gz`. Nothing is ever pruned.
2. **Proof the backup restores** — wipes a database, restores that dump into it *from empty*,
   verifies it, and only then points the site at it. If you can browse the colony at
   `http://<nas-ip>:8080`, the backup is provably good — not "the file was 680 KB and exited 0".
3. **A location you can rebuild production from** — alongside the data it mirrors the source
   repo and pulls a nightly kit of everything else the VPS needs (secrets, nginx and mail
   config, DKIM keys, cron, package list, live DNS). See [REBUILD.md](REBUILD.md).

A backup you have never restored is a hypothesis. This turns it into a nightly test.

**Trust posture:** this NAS holds the production credentials and the unredacted database —
same keys as live, deliberately, because a copy you have to reconstruct secrets for is not a
location you can rebuild from. Treat the NAS as production infrastructure: it is now one of
the two machines where a compromise means a full compromise.

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
| Anonymous `git clone --mirror` of the GitHub repo (it is **public** — no credential needed) | 26 MB, `06464a6` @ 2026-07-24 |
| Same clone via a throwaway container, for a NAS with no git package | works (`alpine/git`, `safe.directory='*'`) |
| `rebuild-kit.sh` with every source path absent (wrong host / not root) | **exits 1**, emits nothing — it refuses to ship a technically-valid, practically-empty kit |

## Layout on the NAS

```
/volume1/wildwatch/
├── nas-mirror/          <- this directory (docker-compose.yml, Dockerfile, .env)
├── app/                 <- SPA dist at the root, PHP API in app/api/  (rsynced from the Mac)
├── shared/
│   ├── secrets.php      <- local DB credentials; app/api/secrets.php is a symlink to this
│   ├── active_db        <- "ww_a" or "ww_b" — which restore slot is live
│   ├── nas.env          <- WW_API_KEY (production key), chmod 600 root
│   └── id_nas           <- SSH key for fetching the rebuild kit from the VPS
├── backups/YYYY/MM/     <- database dumps. Never pruned.           ~680 KB/night
├── kits/YYYY/MM/        <- server config + secrets from the VPS.   small, also kept forever
├── repo.git             <- bare mirror of the GitHub repo          26 MB, updated nightly
├── mac-kit/             <- hand-copied irreplaceables (see REBUILD.md)
├── status/index.html    <- nightly report, served at /status/
├── logs/nightly.log
└── bin/{nightly.sh,rebuild-kit.sh}
```

Two database slots (`ww_a`, `ww_b`) alternate. Each night the **inactive** one is dropped,
recreated empty, restored and checked; the live slot only flips once the checks pass. A bad
night therefore leaves yesterday's good copy serving, and never blanks the site.

## Requirements

- A Synology that can run **Container Manager** (DSM 7.2+, x86_64 or arm64 — most Plus/Value
  models; not the older ARMv7 boxes). Non-Docker fallback below.
- ~1 GB of disk. The archive grows at **~680 KB/night ≈ 250 MB/year** for dumps plus a small
  config kit, so "forever" is genuinely fine; the repo mirror is a flat 26 MB.
- Outbound HTTPS **and SSH** from the NAS. **No port forward, no reverse-proxy entry, no
  QuickConnect rule** — nothing inbound, ever.

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

**4. Let the NAS fetch the rebuild kit from the VPS.** On the **NAS**, as root:

```bash
ssh-keygen -t ed25519 -N '' -C nas-rebuild-kit -f /volume1/wildwatch/shared/id_nas
cat /volume1/wildwatch/shared/id_nas.pub
```

On the **VPS**, install the kit script and pin the key to it — same forced-command pattern the
CI deploy key already uses, so a stolen NAS key can only ever produce a kit:

```bash
sudo install -m 700 -o root -g root rebuild-kit.sh /usr/local/bin/rebuild-kit.sh   # from repo bin/
# append to /home/mark/.ssh/authorized_keys, one line:
command="sudo /usr/local/bin/rebuild-kit.sh",restrict ssh-ed25519 AAAA... nas-rebuild-kit
```

It needs `sudo` to read `secrets.php`, `/etc/postfix/sasl_passwd` and the DKIM keys; `mark` has
passwordless sudo. Test it from the NAS before scheduling anything:

```bash
ssh -i /volume1/wildwatch/shared/id_nas mark@wildwatch.co.nz > /tmp/kit.tar.gz
tar -tzf /tmp/kit.tar.gz | head        # should list kit/files/var/www/wildwatch/shared/secrets.php
```

To include the Maildirs as well, make the forced command
`command="sudo /usr/local/bin/rebuild-kit.sh --with-mail"` and set `KIT_KEEP=7` in the task's
environment — mailboxes are far larger than config, and keeping those forever will hurt.

**5. First run:** `/volume1/wildwatch/bin/nightly.sh` — takes a few seconds, prints each step.

**6. DSM → Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
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

## Consequences of it holding the real keys

This is the intended design — a third location that needs a secret you don't have there isn't a
third location — but it is worth being explicit about what follows, because these are now facts
about the system rather than open questions:

- **Her NAS is production infrastructure.** It holds the production API key, the DB passwords,
  the SMTP2GO relay credential and the DKIM signing keys, plus every colony's data and every
  observer's email and password hash. Whoever can reach that box can act as wildwatch.co.nz,
  including sending mail that passes DKIM. Worth saying to her in those words, once.
- **Keep the secrets out of DSM's own logs.** `shared/nas.env`, `shared/id_nas` and the kit
  archives are root-owned `chmod 600`/`400`. Never put a key in the Task Scheduler command line —
  DSM stores and mails that in plain text.
- **The SSH key is scoped even though the payload isn't.** The forced command means the NAS can
  only ask for a kit, never get a shell — so a stolen NAS key doesn't add a way *in* to the VPS
  beyond the secrets the kit already contains.
- **Rotation now means three places**, not two: VPS, Mac, NAS. `shared/nas.env` and
  `shared/secrets.php` are the NAS copies to update.
- **DSM's own protections still matter here** — disable the admin account, 2FA on any account
  that can log in, and keep Container Manager updated. This box is now worth attacking.

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
