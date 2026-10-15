"""stackctl: the robot-migration instance's only door to docker.

pwmig-am has no docker socket (an agent with one could reach every container on the host). The porting
agents still need one docker operation: turning the CRM stack's clock on or off, which recreates the app
and Keycloak with or without libfaketime. This service does exactly that for compose projects `pwmig` and `pwmig2`,
and nothing else:

  GET  /status              both stacks' containers and clock states
  POST /clock/on[?stack=S]   recreate S's app + keycloak under libfaketime, wait until the app answers and
                             reaches Keycloak. S is the suite's stack name: ui (project pwmig, the default)
                             or ui2 (project pwmig2, lane 2 of the queue)
  POST /clock/off[?stack=S]  the same without libfaketime (the default: the JVM idles at ~470% CPU with it)

One clock move runs at a time, and only one stack has its clock on at a time: two faked JVMs plus two
faked Keycloaks would take most of this shared host's CPU. A clock-on waits up to 45 minutes for the
other stack's clock to go off, then fails (the agent asks rather than hangs).

It also keeps the two socat forwarders alive. Each lives in another container's network namespace
(ports in am's, keycloak-forward in the app's), so when that container restarts the forwarder is left in a
dead namespace while docker still shows it Up. Every minute, a forwarder older than its host is recreated.

The compose files and env come from the read-only pwmig_src volume; the project name is fixed here.
"""
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KIT = '/src/agentmanager/deploy/robot-migration'
# Suite stack name -> compose project, files and the ports the agents use for it.
STACKS = {
    'ui': {'project': 'pwmig', 'override': 'pwmig.override.yml', 'env': 'pwmig.env', 'app_port': '8083', 'kc_port': '8280'},
    'ui2': {'project': 'pwmig2', 'override': 'pwmig2.override.yml', 'env': 'pwmig2.env', 'app_port': '8084', 'kc_port': '8281'},
}
APP_FAKETIME = '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1'
KC_FAKETIME = '/opt/faketime/libfaketime.so.1'
lock = threading.Lock()


def compose(stack):
    c = STACKS[stack]
    return ['docker', 'compose', '-p', c['project'],
            '-f', '/src/ase-crm/docker/docker-compose.yml',
            '-f', f"{KIT}/compose/{c['override']}",
            '--env-file', '/src/ase-crm/.env',
            '--env-file', f"{KIT}/compose/{c['env']}"]


def name(stack, service):
    return f"{STACKS[stack]['project']}-{service}"


def state_file(stack):
    return '/state/clock' if stack == 'ui' else f'/state/clock-{stack}'


def clock_of(stack):
    f = state_file(stack)
    return open(f).read().strip() if os.path.exists(f) else 'off'


def run(cmd, env=None, timeout=900):
    p = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"{' '.join(cmd[:6])}... failed: {(p.stderr or p.stdout)[-800:]}")
    return p.stdout


def exists(container):
    return subprocess.run(['docker', 'inspect', container], capture_output=True).returncode == 0


def clock_env(mode):
    env = dict(os.environ)
    env['APP_LD_PRELOAD'] = APP_FAKETIME if mode == 'on' else ''
    env['KC_LD_PRELOAD'] = KC_FAKETIME if mode == 'on' else ''
    return env


def kcadm(stack, *args):
    return run(['docker', 'exec', name(stack, 'keycloak'), '/opt/keycloak/bin/kcadm.sh', *args], timeout=120)


def kc_redirects(stack):
    port = STACKS[stack]['app_port']
    deadline = time.time() + 600
    while True:
        try:
            kcadm(stack, 'config', 'credentials', '--server', 'http://localhost:8080', '--realm', 'master',
                  '--user', 'admin', '--password', 'admin')
            break
        except RuntimeError:
            if time.time() > deadline:
                raise
            time.sleep(3)
    cid = kcadm(stack, 'get', 'clients', '-r', 'alepo', '-q', 'clientId=crm-client', '--fields', 'id',
                '--format', 'csv', '--noquotes').strip()
    kcadm(stack, 'update', f'clients/{cid}', '-r', 'alepo',
          '-s', f'redirectUris=["http://localhost:{port}/*","http://127.0.0.1:{port}/*"]',
          '-s', f'webOrigins=["http://localhost:{port}","http://127.0.0.1:{port}"]')


def curl_in(container, url, timeout='10'):
    return subprocess.run(['docker', 'exec', container, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
                           '-m', timeout, url], capture_output=True, text=True).stdout


def wait_app(stack):
    # Asked from inside the app container: stackctl is on pwmig-net only and cannot reach pwmig2-net.
    app, kc_port = name(stack, 'app'), STACKS[stack]['kc_port']
    deadline = time.time() + 3600
    while time.time() < deadline:
        if curl_in(app, 'http://localhost:8081/actuator/health', '5') == '200':
            kc = curl_in(app, f'http://localhost:{kc_port}/realms/alepo')
            if kc == '200':
                return
            raise RuntimeError(f'{app} is up but cannot reach Keycloak (localhost:{kc_port} -> {kc})')
        time.sleep(5)
    raise RuntimeError(f'{app} did not answer /actuator/health within an hour')


def set_clock(stack, mode):
    env = clock_env(mode)
    try:
        run([*compose(stack), 'up', '-d', '--no-build', '--no-deps', 'keycloak', 'app'], env=env)
        kc_redirects(stack)
    finally:
        # keycloak-forward lives in the app's network namespace. Once the app is recreated it must be too,
        # even when a step above failed: otherwise it stays in the old app's namespace and localhost:KC_PORT
        # answers nothing inside the new app, until someone recreates it by hand.
        run([*compose(stack), 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'keycloak-forward'], env=env)
    wait_app(stack)
    os.makedirs('/state', exist_ok=True)
    with open(state_file(stack), 'w') as f:
        f.write(mode)
    app = name(stack, 'app')
    preload = run(['docker', 'exec', app, 'printenv', 'LD_PRELOAD'], timeout=30).strip() if mode == 'on' else ''
    return f"{app}: libfaketime {mode} (LD_PRELOAD='{preload}')"


def move_clock(stack, mode):
    """One move at a time; a clock-on also waits for every other stack's clock to be off."""
    deadline = time.time() + 45 * 60
    while True:
        with lock:
            busy = [s for s in STACKS if s != stack and clock_of(s) == 'on'] if mode == 'on' else []
            if not busy:
                return set_clock(stack, mode)
        if time.time() > deadline:
            raise RuntimeError(f"stack {busy[0]}'s clock stayed on for the 45 minutes this waited; only one stack's "
                               f"clock may be on at a time. Ask before turning {stack}'s on.")
        time.sleep(15)


# (host container, stack, compose service, forwarder container): the forwarder shares the host's network
# namespace, so it is left in a dead one when the host restarts, while docker still shows it Up.
FORWARDERS = [('pwmig-am', 'ui', 'ports', 'pwmig-ports'), ('pwmig-app', 'ui', 'keycloak-forward', 'pwmig-keycloak-forward'),
              ('pwmig-am', 'ui2', 'ports', 'pwmig2-ports'), ('pwmig2-app', 'ui2', 'keycloak-forward', 'pwmig2-keycloak-forward')]


def started_at(container):
    return run(['docker', 'inspect', '-f', '{{.State.Running}} {{.State.StartedAt}}', container], timeout=30).split()


def attach_am():
    # pwmig2-ports resolves pwmig2-* from pwmig-am's namespace, so pwmig-am must be on pwmig2-net. A recreated
    # pwmig-am comes back on pwmig-net only.
    if subprocess.run(['docker', 'network', 'inspect', 'pwmig2-net'], capture_output=True).returncode:
        return  # no lane 2 stack
    nets = run(['docker', 'inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', 'pwmig-am'], timeout=30).split()
    if 'pwmig2-net' not in nets:
        print('[stackctl] attaching pwmig-am to pwmig2-net', flush=True)
        run(['docker', 'network', 'connect', 'pwmig2-net', 'pwmig-am'], timeout=60)


def heal_forwarders():
    while True:
        time.sleep(60)
        # A clock move recreates keycloak-forward itself; never race it.
        if not lock.acquire(blocking=False):
            continue
        try:
            try:
                attach_am()
            except Exception as e:  # noqa: BLE001
                print(f'[stackctl] attaching pwmig-am to pwmig2-net failed: {e}', flush=True)
            for host, stack, service, fwd in FORWARDERS:
                if not (exists(host) and exists(fwd)):
                    continue
                try:
                    (h_up, h_at), (_, f_at) = started_at(host), started_at(fwd)
                    # Second resolution: a forwarder recreated in the same second as its host is current.
                    if h_up == 'true' and h_at[:19] > f_at[:19]:
                        print(f'[stackctl] {fwd} predates {host} ({f_at[:19]} < {h_at[:19]}): recreating it', flush=True)
                        run([*compose(stack), 'up', '-d', '--no-build', '--no-deps', '--force-recreate', service],
                            env=clock_env(clock_of(stack)), timeout=300)
                except Exception as e:  # noqa: BLE001
                    print(f'[stackctl] forwarder check for {fwd} failed: {e}', flush=True)
        finally:
            lock.release()


def status():
    out = {}
    for stack, c in STACKS.items():
        ps = run(['docker', 'ps', '-a', '--filter', f"label=com.docker.compose.project={c['project']}",
                  '--format', '{{.Names}}\t{{.Status}}'], timeout=60)
        out[stack] = {'project': c['project'], 'clock': clock_of(stack),
                      'containers': [dict(zip(('name', 'status'), l.split('\t'))) for l in ps.splitlines() if l]}
    # Lane 1's shape at the top level, as before, for callers that read `clock` and `containers`.
    return {**out['ui'], 'stacks': out}


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = (body if isinstance(body, str) else json.dumps(body)).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json' if not isinstance(body, str) else 'text/plain')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/status':
            try:
                return self.reply(200, status())
            except Exception as e:  # noqa: BLE001
                return self.reply(500, str(e))
        self.reply(404, 'only GET /status, POST /clock/on[?stack=ui|ui2], POST /clock/off[?stack=ui|ui2]\n')

    def do_POST(self):
        path, _, query = self.path.partition('?')
        stack = dict(p.split('=', 1) for p in query.split('&') if '=' in p).get('stack', 'ui')
        if path not in ('/clock/on', '/clock/off') or stack not in STACKS:
            return self.reply(404, 'only POST /clock/on[?stack=ui|ui2], POST /clock/off[?stack=ui|ui2]\n')
        mode = path.rsplit('/', 1)[1]
        try:
            return self.reply(200, move_clock(stack, mode) + '\n')
        except Exception as e:  # noqa: BLE001
            # Logged as well as returned: the caller is an agent, and its reply is not where an operator looks.
            print(f'[stackctl] clock {mode} for {stack} failed: {e}', flush=True)
            return self.reply(500, f'clock {mode} for {stack} failed: {e}\n')

    def log_message(self, fmt, *args):
        print(f'[stackctl] {self.address_string()} {fmt % args}', flush=True)


if __name__ == '__main__':
    threading.Thread(target=heal_forwarders, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 7070), Handler).serve_forever()
