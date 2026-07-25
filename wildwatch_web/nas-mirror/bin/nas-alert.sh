#!/bin/bash
# Runs ON THE VPS. Emails an alert about the NAS backup mirror through the wildwatch mail
# server. ASCII ONLY, enforced: the SMTP2GO relay does not offer SMTPUTF8, so any non-ASCII
# byte (a stray em-dash, smart quote, accent) bounces the whole message -- which for an
# alert means it silently never arrives. tr strips anything outside printable ASCII.
#
#   nas-alert.sh "short subject" "body text"
set -u
TO="${ALERT_TO:-markhebberd@gmail.com}"
FROM="mark@wildwatch.co.nz"
ascii() { LC_ALL=C tr -cd '\11\12\15\40-\176'; }
SUBJECT=$(printf '%s' "${1:-alert}" | ascii)
BODY=$(printf '%s' "${2:-The Wildwatch NAS backup mirror needs attention.}" | ascii)

printf 'From: Wildwatch Mirror <%s>\nTo: %s\nSubject: [Wildwatch mirror] %s\n\n%s\n\nStatus page: http://192.168.1.253:8080/status/\nSent (UTC): %s\n' \
  "$FROM" "$TO" "$SUBJECT" "$BODY" "$(date -u '+%Y-%m-%d %H:%M UTC')" \
  | /usr/sbin/sendmail -t
