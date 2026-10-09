"""stackctl: the robot-migration instance's only door to docker.

pwmig-am has no docker socket (an agent with one could reach every container on the host). The porting
agents still need one docker operation: turning the CRM stack's clock on or off, which recreates the app
and Keycloak with or without libfaketime. This service does exactly that for compose project `pwmig`,
and nothing else:

  GET  /status      the pwmig containers and the clock state
  POST /clock/on    recreate app + keycloak under libfaketime, wait until the app answers and reaches Keycloak
  POST /clock/off   the same without libfaketime (the default: the JVM idles at ~470% CPU with it)

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
    run([*COMPOSE, 'up', '-d', '--no-build', '--no-deps', 'keycloak', 'app'], env=env)
    kc_redirects()
    run([*COMPOSE, 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'keycloak-forward'], env=env)
    wait_app()
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, 'w') as f:
        f.write(mode)
    preload = run(['docker', 'exec', 'pwmig-app', 'printenv', 'LD_PRELOAD'], timeout=30).strip() if mode == 'on' else ''
    return f"pwmig-app: libfaketime {mode} (LD_PRELOAD='{preload}')"


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
                return self.reply(500, f'clock {mode} failed: {e}\n')

    def log_message(self, fmt, *args):
        print(f'[stackctl] {self.address_string()} {fmt % args}', flush=True)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 7070), Handler).serve_forever()
