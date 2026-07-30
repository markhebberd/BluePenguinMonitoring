# Wildwatch NAS mirror

A complete third copy of Wildwatch on a Synology NAS (a DS423+), at a second physical site,
that rebuilds itself every night, serves the result on the LAN, and emails if it ever stops.
It does three jobs:

1. **Backup destination** — pulls `https://wildwatch.co.nz/api/backup.php` nightly and keeps
   every dump forever under `backups/YYYY/MM/YYYY-MM-DD.sql.gz`. Nothing is ever pruned.
2. **Proof the backup restores** — drops a database, restores that dump into it *from empty*,
   verifies it (tables, row counts, freshness, a real login round-trip), and only then points
   the site at it. If you can log into the colony at `http://192.168.1.253:8080`, the backup is
   provably good — not "the file was ~950 KB and exited 0".
3. **A location you can rebuild production from** — alongside the data it mirrors the source
   repo and pulls a nightly kit of everything else the VPS needs (secrets, nginx and mail
   config, DKIM keys, cron, package list, live DNS). See [REBUILD.md](REBUILD.md).

A backup you have never restored is a hypothesis. This turns it into a nightly test — and
tells you (by email) the mornings it can't.

**Trust posture:** this NAS holds the production credentials and the unredacted database —
same keys as live, deliberately, because a copy you have to reconstruct secrets for is not a
location you can rebuild from. Treat the NAS as production infrastructure: it is now one of
the machines where a compromise means a full compromise.

## Architecture at a glance

- **One container** (`wildwatch`), built from [Dockerfile](Dockerfile): Debian 13 + PHP 8.4 +
  MariaDB 11.8 — the *same* versions as the production VPS, so a dump that restores here
  restores there. Apache + mod_php stands in for the VPS's nginx + php-fpm.
- **Everything under one folder**, `/volume1/docker/wildwatch` (inside the existing `docker`
  shared folder). Removal is: delete the Container Manager project, delete the folder. No named
  volumes, no extra packages, no DSM config touched.
- **Plain HTTP, LAN-only.** Published on `0.0.0.0:8080` (all interfaces, so it survived the
  static-IP switch and any future one). The NAS has no WAN interface and no port is forwarded,
  so "all interfaces" is still the house LAN. Login uses the real Wildwatch password over HTTP
  on the LAN — an accepted trade-off (see below).
- **Pull-only.** The NAS reaches out to production; production never reaches in. Three nightly
  flows, all outbound: HTTPS for the dump, git for the source, SSH (forced-command) for the kit
  + release + check-in.

## Verified against real production data

| Check | Result |
|---|---|
| Fixed dump restores into an **empty** MariaDB 11.8.6 (identical to prod) | **18 tables, 44,551 observations, 1,042 penguins, 16,828 scans** |
| Generated column (`penguins.is_dead`) | excluded by the fixed `backup.php` (see below), recomputed on insert |
| SPA + client-side route over HTTP | `GET /` 200, `GET /day/...` 200 |
| API unauthenticated | `GET /api/snapshot.php` → **401** (up, demanding a login) |
| **Full login round-trip** | log in → token → token accepted on the next request → snapshot 200 |
| App release pulled from the VPS | `app/` tracks production's deployed release, stamped with its git rev |
| Alert email path | test mail relayed `250 OK` to the inbox; fail + no-checkin alerts fire |

## Three production fixes this shook out

These were found *because* the mirror actually restores and logs in every night — things a
"backup exited 0" never catches:

- **`backup.php` dumped generated columns.** `penguins.is_dead` is `STORED GENERATED`; naming
  it in an `INSERT` makes MariaDB abort the restore at error 1906 — so **every prior backup was
  unrestorable** (it would silently drop all penguins). Fixed to select columns from
  `information_schema`, excluding generated ones. Committed + deployed to production.
- **App DB user needed `CREATE`.** `crud.php` lazily runs `CREATE TABLE IF NOT EXISTS sessions`
  on login; the mirror's `ww` user only had DML, so login 500'd. Now granted `ALL` on the
  `ww_%` pattern (matching production), which survives the nightly slot rebuilds.
- **Apache dropped the `Authorization` header.** nginx forwards it; Apache doesn't, so a minted
  token was rejected on the very next request. Fixed with `SetEnvIf Authorization ...` in
  [apache-site.conf](apache-site.conf).

## Layout on the NAS

```
/volume1/docker/wildwatch/
├── nas-mirror/          <- this directory (Dockerfile, compose-template.yml, docker-compose.yml, .env, bin/)
├── app/                 <- SPA at the root, PHP API in app/api/  (pulled nightly from the VPS release)
├── shared/
│   ├── secrets.php      <- local DB creds; app/api/secrets.php symlinks to it; group-readable by www-data (33)
│   ├── active_db        <- "ww_a" or "ww_b" — which restore slot is live
│   ├── nas.env          <- WW_API_KEY (production read key), root 600
│   └── id_nas           <- SSH key for kit/release/check-in from the VPS, root 600
├── db/                  <- MariaDB data (bind mount; both slots live here)
├── backups/YYYY/MM/     <- database dumps. Never pruned.               ~950 KB/night
├── kits/YYYY/MM/        <- server config + secrets from the VPS.       small, also kept forever
├── repo.git             <- bare mirror of the GitHub repo             ~26 MB, updated nightly
├── mac-kit/             <- hand-copied irreplaceables (see REBUILD.md)
├── status/index.html    <- nightly report, served at /status/
├── logs/nightly.log
└── bin/                 <- nightly.sh + copies of the VPS-side scripts
```

Two database slots (`ww_a`, `ww_b`) alternate. Each night the **inactive** one is dropped,
recreated empty, restored and checked; the live slot only flips once the checks pass. A bad
night therefore leaves yesterday's good copy serving, and never blanks the site.

## Requirements

- A Synology running **Container Manager** (DSM 7.2+, x86_64 or arm64). This deployment: DS423+,
  DSM 7.3.2, 2 GB RAM. MariaDB is tuned small in the Dockerfile (64 MB buffer pool, etc.) to fit.
- ~1 GB of disk. Dumps grow ~950 KB/night (~350 MB/year); the repo mirror is a flat ~26 MB.
  Space is not the constraint — RAM is.
- Outbound HTTPS **and SSH** from the NAS. **No port forward, no reverse-proxy entry, no
  QuickConnect rule** — nothing inbound, ever.

## Setup

The app code and DB schema now come from production automatically (nightly release pull + dump),
so there is **no dev-machine dependency** in steady state. First-time setup:

**1. Build the mirror image on the NAS** (the Dockerfile changes ~never — only on a PHP/MariaDB
major bump). Container Manager's Project wizard can't build from a Dockerfile, so build via CLI:

```bash
cd /volume1/docker/wildwatch/nas-mirror
sudo docker build -t wildwatch-mirror:latest .
```

**2. Run the bootstrap** (idempotent — safe to re-run), which writes `.env`/`secrets.php`/
`nas.env`, generates the SSH key, renders an image-only `docker-compose.yml`, and starts it:

```bash
WW_API_KEY='<production read key>' \
  sudo WW_ROOT=/volume1/docker/wildwatch bash nas-mirror/bin/bootstrap-nas.sh
```

Pass `START=0` to prepare everything but create the container yourself in **Container Manager →
Project → Create** (image-only compose validates there; a clean `wildwatch` name that DSM
tracks properly).

> **Never copy `wildwatch_web/.htaccess` into `app/`.** It force-redirects HTTP→HTTPS, which
> breaks a plain-HTTP LAN site instantly. The release pull strips it; `apache-site.conf` sets
> `AllowOverride None` as a second line of defence.

**3. Pin the NAS key on the VPS** to the forced-command dispatcher (so the key can only ask for
`kit`/`release`/`checkin`, never a shell):

```bash
# on the VPS, install the helper scripts from this repo's bin/:
sudo install -m 755 -o root -g root {rebuild-kit,release-tar,nas-fetch,nas-checkin,nas-alert,nas-watchdog,nas-reach}.sh /usr/local/bin/
# append to /home/mark/.ssh/authorized_keys, one line (key from shared/id_nas.pub):
command="/usr/local/bin/nas-fetch.sh",restrict ssh-ed25519 AAAA... nas-rebuild-kit
# watchdog cron (daily) + reachability cron (every 5 min):
echo '0 21 * * * root /usr/local/bin/nas-watchdog.sh' | sudo tee /etc/cron.d/nas-watchdog
echo '*/5 * * * * root /usr/local/bin/nas-reach.sh'   | sudo tee /etc/cron.d/nas-reach
```

**4. First run + schedule.** Run `sudo /volume1/docker/wildwatch/bin/nightly.sh` once and watch
it go green. Then schedule it — see **Scheduling** below.

## Scheduling

The nightly runs from **cron at 06:30 NZ** (Pacific/Auckland — same zone as the NAS, so it
tracks DST). It's a hand-added line in `/etc/crontab`, TAB-delimited as DSM's `synocrond`
requires, and **verified to actually fire** (a one-minute test cron ran):

```
30	6	*	*	*	root	/volume1/docker/wildwatch/bin/nightly.sh
```

06:30 is 30 min after the existing devian backup (an independent second copy) — the mirror
pulls its own fresh dump from production and does not depend on devian.

> DSM's Task Scheduler GUI was **not** used, because its "email on failure" is a false comfort
> here: DSM email is unconfigured, and even configured it can't email you when the NAS is *off*.
> Alerting is handled by the dead-man's-switch below instead.

## Alerting (self-hosted dead-man's-switch)

Uses the existing `@wildwatch.co.nz` mail server, and **every path was tested** (real mail
relayed `250 OK`). At the end of every run, `nightly.sh` checks in with the VPS over the same
SSH channel: `checkin ok` on success, `checkin fail` otherwise.

- **`checkin fail`** → the VPS emails you immediately ([nas-checkin.sh](bin/nas-checkin.sh)).
- **No check-in for ~20h** → the VPS watchdog ([nas-watchdog.sh](bin/nas-watchdog.sh), cron
  21:00 UTC) emails you. This is the important one: it catches the NAS being off, the cron
  breaking, or the network dying — none of which a NAS-side alert could ever report.
- **The NAS stops answering at all** → the reachability watcher ([nas-reach.sh](bin/nas-reach.sh),
  cron every 5 min) emails **markhebberd@gmail.com and bdot@snotch.com** — wider than the other
  two, because a NAS that is off stays off until someone in the house walks past it. It calls
  the mirror's own API through the Cloudflare tunnel; any JSON back means the machine is there,
  and only the edge apologising for it (HTTP 502–530, an Access login page, no answer at all)
  counts as unreachable.

  **Edge-triggered: one email when it goes down, one when it comes back, nothing in between.**
  A five-minute check that mailed every time would be a flood you'd learn to ignore. It waits
  for **3 failures in a row (~15 min)** before calling it down, so a reboot or a flapping tunnel
  doesn't alarm; the nightly run never trips it, since `nightly.sh` swaps DB slots inside the
  running container and never stops it. State (`reach-state`, `reach-fails`, `reach-since`)
  lives in `/var/lib/nas-mirror/` alongside the check-in files. Overridable for testing:
  `sudo STATE=/tmp/nr SECRETS=/tmp/fake.php ALERT_TO=you@example.com nas-reach.sh`.

  This says nothing about whether the *backup* is good — that's the two alerts above. It only
  answers "is the machine there?", which nothing else asked between nightly runs.

> **Alerts are ASCII-only, enforced.** The SMTP2GO relay doesn't offer SMTPUTF8, so a single
> non-ASCII character (an em-dash, a smart quote) bounces the whole message — a silent-failure
> trap for an alert. [nas-alert.sh](bin/nas-alert.sh) strips anything non-ASCII.

## What the nightly run does

```
download dump ─> archive forever ─> mirror git repo ─> fetch kit ─> pull app release
                                                          │
        drop+recreate the INACTIVE slot ──> restore into it from empty
                                                          │
   verify (tables, row counts vs last night, freshness) ──> flip the live slot
                                                          │
        smoke test (site 200 / API 401) ──> login round-trip ──> status page
                                                          │
                              check in with the VPS (ok | fail)
```

Archiving happens before the restore, so a night where the restore fails still captures the
dump, the code and the kit. The live slot only flips after the checks pass. A failed app-release
pull is a **warning**, not a failure — the mirror keeps serving the code it already has; the
restore is what the badge certifies.

## What Britta sees

- `http://192.168.1.253:8080/status/` — a plain-language report: a big count of tested backups,
  a **calendar** of every verified night (green = a restore-tested backup that day; dim = the NAS
  was off), last night's step-by-step detail, and a green **RESTORE VERIFIED** / red **RESTORE
  FAILED** badge.
- `http://192.168.1.253:8080/` — Wildwatch itself, her normal login. The observer accounts and
  password hashes come out of the restored backup, so logging in is *itself* part of the proof.

Anything she edits there vanishes at 06:30 when the slot is rebuilt. The status page says so.

## App code stays in sync automatically

The nightly dump carries production's *schema*, and the nightly **release pull** copies
production's *deployed* SPA + PHP over the SSH channel — so both track production with no
dev-machine in the loop. The only deliberate manual step left is a MariaDB/PHP *major* version
bump (edit the Dockerfile, rebuild the image, recreate the container) — and the nightly restore
is its own canary for that: it goes red if the versions ever become incompatible.

## Consequences of it holding the real keys

- **The NAS is production infrastructure.** It holds the production API key, DB passwords, the
  SMTP2GO relay credential and the DKIM signing keys, plus every colony's data and every
  observer's email + password hash. Whoever reaches that box can act as wildwatch.co.nz. Worth
  saying to Britta once, in those words.
- **The SSH key is scoped even though the payload isn't.** The forced command lets the NAS ask
  only for `kit`/`release`/`checkin`, never a shell — so a stolen NAS key adds no new way *into*
  the VPS beyond the secrets the kit already contains.
- **Rotation now means three places:** VPS, Mac, NAS (`shared/nas.env`, `shared/secrets.php`).
- **DSM's own protections matter here** — disable the admin account, 2FA on anything that can log
  in, keep Container Manager updated. This box is now worth attacking.

## Removing it

`bin/uninstall-nas.sh` on the NAS stops + removes the container and image and revokes the deploy
access (keeps data unless `--purge-data`). Then, on the VPS: `sudo rm /usr/local/bin/nas-*.sh
/usr/local/bin/{rebuild-kit,release-tar}.sh /etc/cron.d/nas-watchdog` and drop the
`nas-rebuild-kit` line from `~/.ssh/authorized_keys`.
