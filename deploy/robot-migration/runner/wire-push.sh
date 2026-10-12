#!/bin/bash
# Points the suite checkout's push URL at the deploy key in /data/am/deploy-key, when there is one.
# Without a key the push URL stays disabled, so nothing can be pushed from this container.
set -euo pipefail
S=/work/ase-crm-testPlaywright-workflow d=/data/am/deploy-key
[[ -d $S/.git ]] || exit 0
if [[ -f $d/id_ed25519 && -f $d/known_hosts ]]; then
  url=$(git -C "$S" remote get-url origin)               # https://github.com/<owner>/<repo>.git
  ssh_url="git@github.com:${url#https://github.com/}"
  git -C "$S" remote set-url --push origin "$ssh_url"
  git -C "$S" config core.sshCommand "ssh -i $d/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=$d/known_hosts -o StrictHostKeyChecking=yes"
  echo "[pwmig] suite pushes to $ssh_url with the deploy key"
else
  git -C "$S" remote set-url --push origin DISABLED-push-from-a-person-only
  git -C "$S" config --unset core.sshCommand 2>/dev/null || true
fi
