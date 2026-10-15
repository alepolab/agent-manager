"""stackctl: the robot-migration instance's only door to docker.

pwmig-am has no docker socket (an agent with one could reach every container on the host). The porting
agents still need one docker operation: turning the CRM stack's clock on or off, which recreates the app
and Keycloak with or without libfaketime. This service does exactly that for compose project `pwmig`,
and nothing else:

  GET  /status      the pwmig containers and the clock state
  POST /clock/on    recreate app + keycloak under libfaketime, wait until the app answers and reaches Keycloak
  POST /clock/off   the same without libfaketime (the default: the JVM idles at ~470% CPU with it)

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

PROJECT = 'pwmig'
KIT = '/src/agentmanager/deploy/robot-migration'
COMPOSE = ['docker', 'compose', '-p', PROJECT,
           '-f', '/src/ase-crm/docker/docker-compose.yml',
           '-f', f'{KIT}/compose/pwmig.override.yml',
           '--env-file', '/src/ase-crm/.env',
           '--env-file', f'{KIT}/compose/pwmig.env']
APP_FAKETIME = '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1'
KC_FAKETIME = '/opt/faketime/libfaketime.so.1'
STATE = '/state/clock'
KC_PORT = '8280'
APP_PORT = '8083'
lock = threading.Lock()


def run(cmd, env=None, timeout=900):
    p = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"{' '.join(cmd[:6])}... failed: {(p.stderr or p.stdout)[-800:]}")
    return p.stdout


def clock_env(mode):
    env = dict(os.environ)
    env['APP_LD_PRELOAD'] = APP_FAKETIME if mode == 'on' else ''
    env['KC_LD_PRELOAD'] = KC_FAKETIME if mode == 'on' else ''
    return env


def kcadm(*args):
    return run(['docker', 'exec', 'pwmig-keycloak', '/opt/keycloak/bin/kcadm.sh', *args], timeout=120)


def kc_redirects():
    deadline = time.time() + 600
    while True:
        try:
            kcadm('config', 'credentials', '--server', 'http://localhost:8080', '--realm', 'master',
                  '--user', 'admin', '--password', 'admin')
            break
        except RuntimeError:
            if time.time() > deadline:
                raise
            time.sleep(3)
    cid = kcadm('get', 'clients', '-r', 'alepo', '-q', 'clientId=crm-client', '--fields', 'id',
                '--format', 'csv', '--noquotes').strip()
    kcadm('update', f'clients/{cid}', '-r', 'alepo',
          '-s', f'redirectUris=["http://localhost:{APP_PORT}/*","http://127.0.0.1:{APP_PORT}/*"]',
          '-s', f'webOrigins=["http://localhost:{APP_PORT}","http://127.0.0.1:{APP_PORT}"]')


def wait_app():
    deadline = time.time() + 3600
    while time.time() < deadline:
        code = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5',
                               'http://pwmig-app:8081/actuator/health'], capture_output=True, text=True).stdout
        if code == '200':
            kc = subprocess.run(['docker', 'exec', 'pwmig-app', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
                                 '-m', '10', f'http://localhost:{KC_PORT}/realms/alepo'], capture_output=True, text=True).stdout
            if kc == '200':
                return
            raise RuntimeError(f'app is up but cannot reach Keycloak (localhost:{KC_PORT} -> {kc})')
        time.sleep(5)
    raise RuntimeError('app did not answer /actuator/health within an hour')


def set_clock(mode):
    env = clock_env(mode)
    try:
        run([*COMPOSE, 'up', '-d', '--no-build', '--no-deps', 'keycloak', 'app'], env=env)
        kc_redirects()
    finally:
        # keycloak-forward lives in the app's network namespace. Once the app is recreated it must be too,
        # even when a step above failed: otherwise it stays in the old app's namespace and localhost:8280
        # answers nothing inside the new app, until someone recreates it by hand.
        run([*COMPOSE, 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'keycloak-forward'], env=env)
    wait_app()
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, 'w') as f:
        f.write(mode)
    preload = run(['docker', 'exec', 'pwmig-app', 'printenv', 'LD_PRELOAD'], timeout=30).strip() if mode == 'on' else ''
    return f"pwmig-app: libfaketime {mode} (LD_PRELOAD='{preload}')"


# (host container, compose service, forwarder container): the forwarder shares the host's network namespace.
FORWARDERS = [('pwmig-am', 'ports', 'pwmig-ports'), ('pwmig-app', 'keycloak-forward', 'pwmig-keycloak-forward')]


def started_at(name):
    return run(['docker', 'inspect', '-f', '{{.State.Running}} {{.State.StartedAt}}', name], timeout=30).split()


def heal_forwarders():
    while True:
        time.sleep(60)
        # A clock move recreates keycloak-forward itself; never race it.
        if not lock.acquire(blocking=False):
            continue
        try:
            mode = open(STATE).read().strip() if os.path.exists(STATE) else 'off'
            for host, service, fwd in FORWARDERS:
                try:
                    (h_up, h_at), (_, f_at) = started_at(host), started_at(fwd)
                    # Second resolution: a forwarder recreated in the same second as its host is current.
                    if h_up == 'true' and h_at[:19] > f_at[:19]:
                        print(f'[stackctl] {fwd} predates {host} ({f_at[:19]} < {h_at[:19]}): recreating it', flush=True)
                        run([*COMPOSE, 'up', '-d', '--no-build', '--no-deps', '--force-recreate', service],
                            env=clock_env(mode), timeout=300)
                except Exception as e:  # noqa: BLE001
                    print(f'[stackctl] forwarder check for {fwd} failed: {e}', flush=True)
        finally:
            lock.release()


def status():
    ps = run(['docker', 'ps', '-a', '--filter', f'label=com.docker.compose.project={PROJECT}',
              '--format', '{{.Names}}\t{{.Status}}'], timeout=60)
    clock = open(STATE).read().strip() if os.path.exists(STATE) else 'off'
    return {'clock': clock, 'containers': [dict(zip(('name', 'status'), l.split('\t'))) for l in ps.splitlines() if l]}


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
        self.reply(404, 'only GET /status, POST /clock/on, POST /clock/off\n')

    def do_POST(self):
        if self.path not in ('/clock/on', '/clock/off'):
            return self.reply(404, 'only GET /status, POST /clock/on, POST /clock/off\n')
        mode = self.path.rsplit('/', 1)[1]
        # One clock move at a time; a second caller waits, as stack.sh's flock did.
        with lock:
            try:
                return self.reply(200, set_clock(mode) + '\n')
            except Exception as e:  # noqa: BLE001
                # Logged as well as returned: the caller is an agent, and its reply is not where an operator looks.
                print(f'[stackctl] clock {mode} failed: {e}', flush=True)
                return self.reply(500, f'clock {mode} failed: {e}\n')

    def log_message(self, fmt, *args):
        print(f'[stackctl] {self.address_string()} {fmt % args}', flush=True)


if __name__ == '__main__':
    threading.Thread(target=heal_forwarders, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 7070), Handler).serve_forever()
