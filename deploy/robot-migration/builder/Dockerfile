# pwmig/builder: the operator's toolbox for the robot-migration instance (see pwmig.sh). Holds no files of
# its own: on first use it clones agent-manager into the pwmig_src volume with the GH_TOKEN from the
# environment (never stored) and runs the pwmig.sh of that fresh clone.
# Build it on the host from stdin, so nothing is written there:  docker build -t pwmig/builder - < Dockerfile
FROM alpine:3.20
LABEL pwmig=1
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git bash curl python3 openssl coreutils
ENTRYPOINT ["/bin/bash", "-c", "set -e; if [ ! -d /src/agentmanager/.git ]; then : \"${GH_TOKEN:?set GH_TOKEN}\"; git -c credential.helper='!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' clone -q --branch \"${AM_BRANCH:-feat/skill-attachments}\" https://github.com/alepolab/agent-manager.git /src/agentmanager; fi; exec bash /src/agentmanager/deploy/robot-migration/builder/pwmig.sh \"$@\"", "--"]
