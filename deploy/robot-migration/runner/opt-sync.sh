#!/bin/bash
# The ui-to-api-optimization workflow's delivery: main-sync.sh for the shared branch `optimization`, under the
# same /work/.deliver.lock, so its pushes and the migration lanes' never interleave.
BRANCH=optimization exec /opt/pwmig/main-sync.sh "$@"
