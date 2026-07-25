#!/bin/bash
# Runs ON THE VPS as the NAS key's forced command. The NAS never gets a shell — it can
# only ask for one of the exact payloads below, chosen by SSH_ORIGINAL_COMMAND:
#
#   ssh nas@vps                 -> rebuild kit (default; config + secrets, config only)
#   ssh nas@vps kit             -> rebuild kit
#   ssh nas@vps kit --with-mail -> rebuild kit including Maildirs
#   ssh nas@vps release         -> the deployed release tree (SPA + PHP)
#   ssh nas@vps checkin ok      -> record a successful nightly (dead-man's-switch heartbeat)
#   ssh nas@vps checkin fail    -> record a failed nightly + email an alert now
#
# Anything else is refused. This is an allowlist of literal strings — nothing from the
# client is ever eval'd or interpolated into a command.
set -uo pipefail

case "${SSH_ORIGINAL_COMMAND:-kit}" in
  kit|"")            exec sudo /usr/local/bin/rebuild-kit.sh ;;
  "kit --with-mail") exec sudo /usr/local/bin/rebuild-kit.sh --with-mail ;;
  release)           exec sudo /usr/local/bin/release-tar.sh ;;
  "checkin ok")      exec sudo /usr/local/bin/nas-checkin.sh ok ;;
  "checkin fail")    exec sudo /usr/local/bin/nas-checkin.sh fail ;;
  *) echo "nas-fetch: refused '${SSH_ORIGINAL_COMMAND}'" >&2; exit 1 ;;
esac
