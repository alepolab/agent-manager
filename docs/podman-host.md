# Running the team stack on a rootless podman host

`docker-compose.team.yml` is written for a host with a Docker daemon. On a
rootless podman host — the WSL boxes here — three of its assumptions are false
by default, and podman **fails** a bind mount whose source is missing rather
than creating one:

    Error: statfs /usr/libexec/docker/cli-plugins: no such file or directory

The fix belongs on the host, not in a second compose file. There was briefly a
`docker-compose.team.podman.yml`; it is gone, and the reason it had to go is
worth recording. It drifted within days of being written — carrying a dead
`JIRA_TICKET_SOURCE` while missing all four live Jira variables, so a podman
deployment had no Jira configuration at all while advertising a setting nothing
read. A second file that must be kept in step by hand will not be. A single
file cannot drift from itself.

## One-time host setup

Run as root. The uid is written literally rather than as `$(id -u)`, because
this is run under sudo and `$(id -u)` would evaluate to 0 there — which is
exactly the mistake that produced a dangling symlink the first time.

```bash
# Substitute your own uid for 9870 (id -u as your normal user, not root).
sudo mkdir -p /usr/libexec/docker/cli-plugins
printf 'L /run/docker.sock - - - - /run/user/9870/podman/podman.sock\n' |
  sudo tee /etc/tmpfiles.d/podman-docker-compat.conf >/dev/null
sudo systemd-tmpfiles --create /etc/tmpfiles.d/podman-docker-compat.conf
```

Then verify — and verify that the target RESOLVES, not merely that the symlink
exists. `ls -l` succeeds on a dangling symlink, so a check built on it reports
success while the thing is broken:

```bash
test -e /run/docker.sock && echo OK || echo DANGLING
docker run --rm -v /var/run/docker.sock:/probe alpine ls -l /probe
```

### Why each piece

- **`/run/docker.sock`, not `/var/run/docker.sock`.** `/var/run` is a symlink to
  `/run`, and systemd-tmpfiles rejects the legacy path with a warning. Compose
  can still mount `/var/run/docker.sock`; it resolves through the symlink.
- **A `tmpfiles.d` rule, not `ln -s`.** `/run` is tmpfs, so a plain symlink is
  gone after a reboot. The rule recreates it at boot.
- **The empty `cli-plugins` directory** exists only so the bind mount has a
  source. Nothing reads it.
- **The socket is `srw-rw---- alepo:alepo`**, so root cannot read it. Run the
  stack as the socket's owner — which is also the user whose podman it is.

## Prerequisites

systemd must be PID 1 (`[boot] systemd=true` in `/etc/wsl.conf`, then
`wsl --shutdown`), with the socket and container units enabled and lingering on:

```bash
loginctl enable-linger "$USER"
systemctl --user enable --now podman.socket podman-restart.service
```

`podman-restart.service` is the half most easily missed: the socket returning
after a reboot does not restart your containers — that unit does.

If systemd-resolved is installed, enabling systemd can take over
`/etc/resolv.conf` and change DNS. Mask it first if the host has a
hand-written resolv.conf (`generateResolvConf = false` in `/etc/wsl.conf`).

## DOCKER_GID on a rootless host

`docker-compose.team.yml` adds the container user to `${DOCKER_GID:-999}` so it
can reach the mounted socket. **On this host that value is `0`, not 999.**

Rootless podman maps the host user to container root, so the socket the compose
file mounts appears inside the container as `root:root` mode `660`. The default
999 grants nothing, and the container user gets a connection refused that looks
exactly like a daemon that is not running:

```
Docker daemon is not running in this container (socket present, nothing
listening — `curl --unix-socket /var/run/docker.sock http://localhost/v1.41/version` exit 7)
```

It is a permission error wearing a connectivity error's clothes. `curl` returns
exit 7 for both.

This only surfaced once the image started running as a non-root user, which it
must — Claude Code refuses `--dangerously-skip-permissions` as root, and every
pipeline agent runs with it. Before that the container was root and could open
the socket regardless.

Set it in the env file the deployment reads:

```
DOCKER_GID=0
```

On a real Docker host the value is that host's `docker` group gid instead —
`getent group docker | cut -d: -f3`. It is host-specific, which is why it is a
variable and not a literal in the compose file.

Verify from inside the running container, and check the response rather than
the exit code alone:

```bash
docker exec agents-ui-team sh -c \
  'curl -s --unix-socket /var/run/docker.sock http://localhost/v1.41/version | head -c 60'
```
