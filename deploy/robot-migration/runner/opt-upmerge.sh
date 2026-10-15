#!/bin/bash
# Brings newly ported specs into branch `optimization`: merges GitHub's workflow/main into a clean checkout on
# optimization and pushes it, under the shared /work/.deliver.lock. The optimization queue's precheck runs it
# after `opt-sync.sh pull`. It never fails the queue: a conflict is aborted and reported on stderr, and the
# lane goes on from the optimization it has. Without a deploy key (push URL DISABLED…) it does nothing.
#   opt-upmerge.sh <checkout>
set -uo pipefail
S=${1:?checkout} B=optimization UP=workflow/main
url=$(git -C "$S" remote get-url --push origin)
[[ $url == DISABLED* ]] && exit 0
[[ $(git -C "$S" branch --show-current) == "$B" ]] || exit 0
[[ -z $(git -C "$S" status --porcelain --untracked-files=no) ]] || exit 0
exec 9>/work/.deliver.lock; flock -w 600 9 || exit 0
GIT_TERMINAL_PROMPT=0 git -C "$S" fetch -q "$url" $UP || { echo "fetch of $UP failed; going on without it" >&2; exit 0; }
git -C "$S" merge-base --is-ancestor FETCH_HEAD $B && exit 0
if git -C "$S" merge -q --no-ff -m "merge $UP into $B (new ported specs)" FETCH_HEAD >&2; then
  GIT_TERMINAL_PROMPT=0 git -C "$S" push origin $B >&2 || echo "push of the $UP merge failed; the next delivery pushes it" >&2
else
  echo "merging $UP into $B conflicts in:" >&2; git -C "$S" diff --name-only --diff-filter=U >&2
  git -C "$S" merge --abort; echo "left $B as it was; resolve by hand" >&2
fi
exit 0
