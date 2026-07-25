# Rebuilding Wildwatch from the NAS

The NAS is a complete third location. If wildwatch.co.nz and the VPS are gone, everything
needed to stand the service back up is in `/volume1/docker/wildwatch`:

| What | Where on the NAS | Covers |
|---|---|---|
| Data | `backups/YYYY/MM/*.sql.gz` | every observation, penguin, scan, observer, verification |
| Code | `repo.git` (bare mirror of the public GitHub repo) | API, SPA, nestcheck, deploy scripts, all docs |
| Everything else | `kits/YYYY/MM/*.tar.gz` | all of `shared/` (secrets.php, secrets.env, the disk-check ssh keypair), nginx vhosts, php-fpm pool, cron, Postfix/Dovecot/Rspamd/Roundcube config, DKIM private keys, package list, firewall, live DNS records |

There are no uploads, photos or on-disk attachments in Wildwatch — the schema has no blob or
file columns — so the dump really is all of the application data.

> The NAS also holds `app/` — production's *deployed* release (built SPA + PHP), refreshed
> nightly. That's what the mirror serves; for an actual rebuild, build from `repo.git` on the new
> host (as below) rather than copying `app/`, since `repo.git` is the source of truth.

## Rebuild

**1. Provision** a host per [DEPLOYMENT.md](../../DEPLOYMENT.md) §"Rebuild from scratch" and
[MIGRATION-TANTRIXLAB-VPS.md](../../MIGRATION-TANTRIXLAB-VPS.md): Debian, nginx, PHP 8.4 + fpm +
`pdo_mysql`, MariaDB 11.x, certbot. `kits/*/state/packages.txt` is the exact package list of the
machine that died, if you want to match it.

**2. Code:**

```bash
git clone /volume1/docker/wildwatch/repo.git wildwatch     # or re-clone from GitHub if it still exists
```

**3. Data** — restore the newest dump. Do **not** build the schema from `database_schema.sql`;
it has drifted (DEPLOYMENT.md:134). The dump carries the real schema:

```bash
mysql -e "CREATE DATABASE wildwatch_nestcheck CHARACTER SET utf8mb4;"
gzip -cd backups/2026/07/2026-07-24.sql.gz | mysql wildwatch_nestcheck
```

Recreate the DB users named in `kits/*/state/db-users.txt` with the passwords from the kit's
`secrets.php`, then grant them on the restored database.

**4. Config** — unpack the newest kit and put the files back:

```bash
tar -xzf kits/2026/07/2026-07-24.tar.gz
# kit/files/<original absolute path> — copy each back to the same location. The whole
# shared/ dir is here: secrets.php (app creds), secrets.env (cron/backup creds), and the
# ssh/ keypair the disk-check uses.
cp -a kit/files/var/www/wildwatch/shared/. /var/www/wildwatch/shared/
cp kit/files/etc/nginx/sites-available/* /etc/nginx/sites-available/
cp kit/files/etc/php/*/fpm/pool.d/wildwatch.conf /etc/php/*/fpm/pool.d/   # php-fpm pool
```

**5. DNS** — point the records in `kit/state/dns.txt` at the new host (Porkbun holds the zone).
The DKIM private keys in `kit/files/var/lib/rspamd/dkim` match the published DKIM TXT record, so
mail keeps authenticating without re-publishing DNS.

**6. TLS** — nothing to restore; `certbot --nginx` reissues once DNS resolves.

## What is *not* in here

- **Mailbox contents.** The kit carries the mail *server* config and the account hashes, so the
  service rebuilds — but the Maildirs are only included if the nightly fetch runs
  `--with-mail` (see README). Set `KIT_KEEP=7` if you turn that on, or the archive grows fast.
- **The nestcheck Play Store upload keystore and `nestcheck/secrets.props`.** These live on the
  Mac, are git-ignored, and are **irreplaceable** — lose the upload key and that Android app can
  never be updated again, by anyone. Nothing in this design backs them up, because the NAS
  cannot reach into the Mac. Copy them to `/volume1/docker/wildwatch/mac-kit/` by hand:

  ```bash
  rsync -av ~/src/penguins/nestcheck/secrets.props \
            <upload-keystore.jks> <play-service-account.json> \
            admin@192.168.1.253:/volume1/docker/wildwatch/mac-kit/
  ```

  They change about never, so a manual copy is fine — but do it once, today, rather than
  discovering the gap during a rebuild. See [RELEASE.md](../../nestcheck/RELEASE.md).

## Verifying the third copy is real

The point of the nightly restore is that this is not a paper exercise: every night the dump is
loaded into an empty database and the site is served from it, so `http://192.168.1.253:8080/status/`
is standing evidence that step 3 works. Steps 4-6 are only proven by doing them — worth one
dry run onto a cheap VPS or a local VM once, then noting the date here.
