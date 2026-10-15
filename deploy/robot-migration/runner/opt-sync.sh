#!/bin/bash
# Branch `optimization` across the ui-to-api-optimization lanes. main-sync.sh's twin for that branch. It uses the
# same delivery lock (/work/.deliver.lock, so it never interleaves with a migration delivery), the same deploy key
# and the same exit codes.
#   opt-sync.sh pull    <checkout>                      fast-forward a clean checkout on optimization from GitHub,
#                                                       then merge workflow/main into it (new ported specs) and push
#   opt-sync.sh deliver <checkout> <branch> <msgfile>   update optimization, merge <branch> --no-ff, push
# deliver exits 0 merged and pushed (or push skipped, says why), 3 conflict (merge aborted, back on <branch>,
# conflicting files printed), 4 push failed (merge stays local), 5 checkout not clean, 6 lock not had in 30 minutes,
# 7 optimization could not be fetched.
# pull never fails the queue: a workflow/main merge that conflicts is aborted and reported on stderr, and the
# lane goes on from the optimization it has.
set -uo pipefail
mode=${1:?pull|deliver} S=${2:?checkout}
B=optimization UP=workflow/main
url=$(git -C "$S" remote get-url --push origin)
fetch_opt() {  # fast-forward local optimization to GitHub; no-op without a push URL
  [[ $url == DISABLED* ]] && return 0
  GIT_TERMINAL_PROMPT=0 git -C "$S" fetch -q "$url" $B || { echo "fetch of $B failed" >&2; return 1; }
  git -C "$S" merge-base --is-ancestor $B FETCH_HEAD || { echo "local $B has commits GitHub lacks; left as is" >&2; return 0; }
  git -C "$S" merge -q --ff-only FETCH_HEAD
}
push_opt() {
  [[ $url == DISABLED* ]] && { echo "push skipped: the push URL is disabled"; return 0; }
  [[ ${PUSH:-yes} == no ]] && { echo "push skipped: pushAfterDeliver is no"; return 0; }
  GIT_TERMINAL_PROMPT=0 git -C "$S" push origin $B 2>&1
}
case $mode in
pull)
  [[ $(git -C "$S" branch --show-current) == "$B" ]] || exit 0
  [[ -z $(git -C "$S" status --porcelain --untracked-files=no) ]] || exit 0
  exec 9>/work/.deliver.lock; flock -w 600 9 || exit 0
  fetch_opt || exit 0
  [[ $url == DISABLED* ]] && exit 0
  GIT_TERMINAL_PROMPT=0 git -C "$S" fetch -q "$url" $UP || { echo "fetch of $UP failed; going on without it" >&2; exit 0; }
  git -C "$S" merge-base --is-ancestor FETCH_HEAD $B && exit 0
  if git -C "$S" merge -q --no-ff -m "merge $UP into $B (new ported specs)" FETCH_HEAD >&2; then
    push_opt >&2 || echo "push of the $UP merge failed; the next delivery pushes it" >&2
  else
    echo "merging $UP into $B conflicts in:" >&2; git -C "$S" diff --name-only --diff-filter=U >&2
    git -C "$S" merge --abort; echo "left $B as it was; resolve by hand" >&2
  fi ;;
deliver)
  b=${3:?branch} msg=${4:?message file}
  exec 9>/work/.deliver.lock; flock -w 1800 9 || { echo "another lane held the delivery lock for 30 minutes" >&2; exit 6; }
  [[ -z $(git -C "$S" status --porcelain --untracked-files=no) ]] || { git -C "$S" status --short >&2; exit 5; }
  [[ $(git -C "$S" branch --show-current) == "$B" ]] || git -C "$S" switch -q $B || exit 5
  fetch_opt || { git -C "$S" switch -q "$b"; exit 7; }
  if ! git -C "$S" merge -q --no-ff -F "$msg" "$b"; then
    git -C "$S" diff --name-only --diff-filter=U
    git -C "$S" merge --abort; git -C "$S" switch -q "$b"; exit 3
  fi
  git -C "$S" log -1 --format="merged %h %s"
  push_opt || exit 4 ;;
*) echo "unknown mode $mode" >&2; exit 2 ;;
esac
