#!/bin/bash
# workflow/main across lanes. Each lane has its own clone of the suite; GitHub (the push URL, read with the
# deploy key) holds the one workflow/main they all deliver to. One delivery at a time, under /work/.deliver.lock.
#   main-sync.sh pull    <checkout>                      fast-forward a clean checkout on workflow/main (queue precheck)
#   main-sync.sh deliver <checkout> <branch> <msgfile>   update workflow/main, merge <branch> --no-ff, push
# deliver exits 0 merged and pushed (prints the push line) or merged with the push skipped (push URL disabled),
# 3 on a conflict (merge aborted, checkout back on <branch>, conflicting files printed), 4 when the push failed
# (the merge stays local), 5 when the checkout is not clean, 6 when the lock was not had within 30 minutes,
# 7 when workflow/main could not be fetched (nothing merged, checkout back on <branch>).
set -uo pipefail
mode=${1:?pull|deliver} S=${2:?checkout}
url=$(git -C "$S" remote get-url --push origin)
fetch_main() {  # fast-forward local workflow/main to GitHub; no-op without a push URL
  [[ $url == DISABLED* ]] && return 0
  GIT_TERMINAL_PROMPT=0 git -C "$S" fetch -q "$url" workflow/main || { echo "fetch of workflow/main failed" >&2; return 1; }
  git -C "$S" merge-base --is-ancestor workflow/main FETCH_HEAD || { echo "local workflow/main has commits GitHub lacks; left as is" >&2; return 0; }
  git -C "$S" merge -q --ff-only FETCH_HEAD
}
case $mode in
pull)
  [[ $(git -C "$S" branch --show-current) == workflow/main ]] || exit 0
  [[ -z $(git -C "$S" status --porcelain --untracked-files=no) ]] || exit 0
  exec 9>/work/.deliver.lock; flock -w 600 9 || exit 0
  fetch_main || true ;;
deliver)
  b=${3:?branch} msg=${4:?message file}
  exec 9>/work/.deliver.lock; flock -w 1800 9 || { echo "another lane held the delivery lock for 30 minutes" >&2; exit 6; }
  [[ -z $(git -C "$S" status --porcelain --untracked-files=no) ]] || { git -C "$S" status --short >&2; exit 5; }
  [[ $(git -C "$S" branch --show-current) == workflow/main ]] || git -C "$S" switch -q workflow/main || exit 5
  fetch_main || { git -C "$S" switch -q "$b"; exit 7; }
  if ! git -C "$S" merge -q --no-ff -F "$msg" "$b"; then
    git -C "$S" diff --name-only --diff-filter=U
    git -C "$S" merge --abort; git -C "$S" switch -q "$b"; exit 3
  fi
  git -C "$S" log -1 --format="merged %h %s"
  [[ $url == DISABLED* ]] && { echo "push skipped: the push URL is disabled"; exit 0; }
  [[ ${PUSH:-yes} == no ]] && { echo "push skipped: pushAfterDeliver is no"; exit 0; }
  GIT_TERMINAL_PROMPT=0 git -C "$S" push origin workflow/main 2>&1 || exit 4 ;;
*) echo "unknown mode $mode" >&2; exit 2 ;;
esac
