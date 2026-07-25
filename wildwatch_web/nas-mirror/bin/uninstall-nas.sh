#!/bin/bash
# Removes the Wildwatch mirror from the NAS. Run as root on the NAS.
#
#   uninstall-nas.sh              stop and remove the container + image, revoke the
#                                 deploy access I added; LEAVES all data in place
#   uninstall-nas.sh --purge-data also delete /volume1/wildwatch (backups, kits, repo,
#                                 database) — irreversible, so it asks first
#
# Everything this mirror created lives in exactly four places, all listed below. Nothing
# else on the NAS was modified: no DSM settings, no existing containers, no other shares.
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

WW_ROOT="${WW_ROOT:-/volume1/wildwatch}"
PURGE=0
[ "${1:-}" = "--purge-data" ] && PURGE=1

echo "== 1. container + image =="
if docker inspect wildwatch >/dev/null 2>&1; then
  docker stop wildwatch >/dev/null 2>&1 && echo "stopped wildwatch"
  docker rm wildwatch   >/dev/null 2>&1 && echo "removed container wildwatch"
else
  echo "no wildwatch container (if it was created as a Container Manager Project, delete"
  echo "the project in the GUI instead: Container Manager -> Project -> wildwatch -> Delete)"
fi
docker image rm wildwatch-mirror:latest >/dev/null 2>&1 && echo "removed image wildwatch-mirror:latest"

echo "== 2. scheduled task =="
echo "delete it in DSM -> Control Panel -> Task Scheduler -> 'Wildwatch nightly backup' -> Delete"
echo "(left to the GUI on purpose — editing DSM's task database from a script is not safe)"

echo "== 3. deploy access =="
if [ -f /etc/sudoers.d/bdot-deploy ]; then
  rm -f /etc/sudoers.d/bdot-deploy && echo "removed /etc/sudoers.d/bdot-deploy (passwordless sudo)"
fi
for home in /var/services/homes/bdot /volume1/homes/bdot; do
  AK="$home/.ssh/authorized_keys"
  if [ -f "$AK" ] && grep -q "markhebberd@gmail.com" "$AK"; then
    grep -v "markhebberd@gmail.com" "$AK" > "$AK.tmp" && mv "$AK.tmp" "$AK"
    chmod 600 "$AK"; echo "removed the deploy SSH key from $AK"
  fi
done
echo "SSH itself was enabled by you in DSM -> Terminal & SNMP; turn it back off there if you want"

echo "== 4. data =="
if [ "$PURGE" = 1 ]; then
  echo "About to delete $WW_ROOT — every archived backup, kit, the repo mirror and the database."
  printf 'Type DELETE to confirm: '; read -r ans
  if [ "$ans" = "DELETE" ]; then
    rm -rf "${WW_ROOT:?}"/{app,shared,backups,kits,status,logs,bin,tmp,db,mac-kit,repo.git,nas-mirror}
    rmdir "$WW_ROOT" 2>/dev/null || true
    echo "deleted $WW_ROOT contents"
    echo "if 'wildwatch' was a DSM shared folder, remove the folder itself in"
    echo "Control Panel -> Shared Folder -> wildwatch -> Delete"
  else
    echo "cancelled — nothing deleted"
  fi
else
  echo "kept $WW_ROOT ($(du -sh "$WW_ROOT" 2>/dev/null | cut -f1) — backups, kits, repo, database)"
  echo "re-run with --purge-data to delete it"
fi

echo
echo "Also on the VPS (not this NAS), if you want the mirror fully unwound:"
echo "  sudo rm -f /usr/local/bin/rebuild-kit.sh"
echo "  remove the 'nas-rebuild-kit' line from /home/mark/.ssh/authorized_keys"
