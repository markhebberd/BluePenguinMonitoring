# Mail server — @wildwatch.co.nz

Self-hosted mail for `@wildwatch.co.nz`, running on the **tantrixlab VPS** (Hetzner,
Debian 13 — see `SERVER-ACCESS.local.md` for host/SSH details). Replaced the old Asura
cPanel mail. Same box that serves wildwatch.co.nz + tantrixlab.com (nginx/php-fpm).

Everything is installed from **Debian `apt` (main)** and kept patched by
`unattended-upgrades` — no Docker, no third-party install scripts.

## Stack

| Component | Role |
|---|---|
| Postfix | SMTP — receive on 25, submission on 587/465, sends outbound direct on 25 |
| Dovecot 2.4 | IMAP + POP3 + LMTP delivery + SASL auth; virtual users |
| Rspamd (+redis) | spam filtering + DKIM signing (milter on 127.0.0.1:11332) |
| unbound | local resolver on 127.0.0.1:5335 for DNSBL lookups (system resolver untouched) |
| Roundcube | webmail at https://mail.wildwatch.co.nz (nginx vhost, php8.4-fpm, sqlite) |
| fail2ban | brute-force jails for sshd/postfix/postfix-sasl/dovecot |
| certbot | Let's Encrypt cert for mail.wildwatch.co.nz (auto-renew) |

## Mailboxes

Virtual users (not system accounts) in `/etc/dovecot/passwd` (SHA512-CRYPT), mail stored
as Maildir under `/var/vmail/<domain>/<user>`, owned by `vmail` (uid/gid 5000).

- **Real mailboxes:** `mark@`, `bdot@`, `marian@`
- **Send-only:** `no-reply@` — not a mailbox; the app sends *through* local Postfix as
  this address (rspamd DKIM-signs it), and inbound mail to it is rejected (`550`).

**Passwords are not stored in this repo** — only one-way hashes exist, on the server.

## Client settings

- **IMAP:** `mail.wildwatch.co.nz` — 993 (SSL) or 143 (STARTTLS)
- **POP3:** `mail.wildwatch.co.nz` — 995 (SSL) or 110 (STARTTLS)
- **SMTP (submission):** `mail.wildwatch.co.nz` — 587 (STARTTLS)
- **Username:** the full email address. Plaintext auth is refused unless encrypted.

Webmail: **https://mail.wildwatch.co.nz** — users change their own password under
**Settings → Password** (backed by the `rc-chpasswd` helper; see runbook).

## Outbound (direct on port 25)

Hetzner opened outbound **port 25** on 2026-08-27, so Postfix now delivers **straight to
each recipient's MX** — the SMTP2GO relay is retired.

- No `relayhost`: `relayhost =` (empty), no `smtp_sasl_*` settings, `/etc/postfix/sasl_passwd`
  deleted. `smtp_tls_security_level = may` (opportunistic TLS, as direct delivery requires).
- `smtp_address_preference = ipv4` — outbound is pinned to the IPv4 that holds the PTR.
- **PTR** is `mail.wildwatch.co.nz`; the IP is clean on Spamhaus/SpamCop/Barracuda/SORBS.
- Verified with Port25's `check-auth@verifier.port25.com`: **SPF pass, DKIM pass**
  (`d=wildwatch.co.nz`, selector `mail`).

Previously (2026-07-04 → 2026-08-27) outbound was relayed through SMTP2GO on 587 because
Hetzner blocked 25 by default. If 25 is ever blocked again, the fallback is to set
`relayhost = [<relay>]:587` plus `smtp_sasl_auth_enable = yes` and a postmap'd
`/etc/postfix/sasl_passwd`, and `systemctl reload postfix`.

## DNS (at Porkbun) & authentication

| Record | Value |
|---|---|
| `MX` @ | `mail.wildwatch.co.nz` |
| `A` mail | the VPS IPv4 |
| `TXT` @ (SPF) | `v=spf1 mx ~all` |
| `TXT` _dmarc | `v=DMARC1; p=none` |
| `TXT` mail._domainkey (DKIM) | rspamd public key, selector `mail` |

- **PTR / reverse DNS** for the VPS IPv4 is set to `mail.wildwatch.co.nz`.
- SPF `v=spf1 mx ~all` covers direct sending: the MX host *is* the sending host.
- Rspamd signs with DKIM `d=wildwatch.co.nz` on the way out, so DMARC aligns.

## Key config file locations (server)

```
/etc/dovecot/local.conf                     # virtual users, Maildir, TLS, LMTP/auth sockets
/etc/dovecot/passwd                          # mailbox hashes (user:hash:5000:5000::::)
/etc/postfix/main.cf, master.cf              # virtual domains, submission, relay, milter
/etc/postfix/vmailbox, virtual               # valid recipients + aliases (postmap'd)
/etc/rspamd/local.d/{dkim_signing,options,worker-proxy}.*
/etc/roundcube/config.inc.php                # webmail (imap/smtp over loopback)
/etc/roundcube/plugins/password/config.inc.php
/usr/local/bin/rc-chpasswd                   # password-change helper (sudo, allowlisted)
/etc/nginx/sites-available/mail.wildwatch.co.nz
/etc/letsencrypt/renewal-hooks/deploy/reload-mail.sh   # reloads postfix/dovecot on renew
```

## Runbook

**Add a mailbox** (`newuser@wildwatch.co.nz`):
1. `echo "newuser@wildwatch.co.nz:$(doveadm pw -s SHA512-CRYPT):5000:5000::::" >> /etc/dovecot/passwd`
   (or feed the password to `doveadm pw`), keep `640 root:dovecot`.
2. `echo "newuser@wildwatch.co.nz OK" >> /etc/postfix/vmailbox && postmap /etc/postfix/vmailbox`
3. Add the address to the `ALLOWED` list in `/usr/local/bin/rc-chpasswd` (so they can
   self-service their password).
4. `systemctl reload postfix dovecot`.

**Remove a mailbox:** delete its lines from `/etc/dovecot/passwd` and
`/etc/postfix/vmailbox` (`postmap` again), drop it from the `rc-chpasswd` allowlist, and
`rm -rf /var/vmail/<domain>/<user>` (only after confirming no wanted mail). Reload.

**Reset a password:** `printf 'user@wildwatch.co.nz:NewPassword\n' | /usr/local/bin/rc-chpasswd`
(there's a ~1s Dovecot passwd-file reload lag before it's active). Users can also do it
themselves in webmail.

**Send-only note:** `no-reply@` must stay out of `/etc/postfix/vmailbox` (so inbound
rejects) but is fine as a `From:` for locally-injected app mail.
