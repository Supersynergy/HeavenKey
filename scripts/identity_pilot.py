#!/usr/bin/env python3
"""Run the isolated passwordless pilot. Never opens a public listener or real vault."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / 'apps/identity-pilot'
BASE = 'http://localhost:18370'
REALM = 'heavenkey-pilot'
# Loopback requests must not use an environment-configured outbound proxy.
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, method='GET', payload=None, token=None, encoded=False):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if payload is None:
        data = None
    elif encoded:
        data = urllib.parse.urlencode(payload).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    else:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    with HTTP.open(urllib.request.Request(BASE + path, data, headers, method=method), timeout=8) as response:
        body = response.read(2 * 1024 * 1024)
        return json.loads(body) if body else None


def configure(admin_token, client_secrets):
    def admin(path='', method='GET', payload=None):
        return request('/admin/realms/' + REALM + path, method, payload, admin_token)

    mapper_id = 'oidc-sha256-pairwise-sub-mapper'
    available = request('/admin/serverinfo', token=admin_token)['protocolMapperTypes']['openid-connect']
    if mapper_id not in {item['id'] for item in available}:
        raise RuntimeError('pairwise_subject_mapper_unavailable')
    request('/admin/realms', 'POST', {
        'realm': REALM, 'enabled': True, 'displayName': 'HeavenKey · lokaler Pilot',
        'registrationAllowed': True, 'resetPasswordAllowed': False, 'rememberMe': False,
        'loginWithEmailAllowed': False, 'duplicateEmailsAllowed': False,
        'sslRequired': 'external', 'accessTokenLifespan': 120, 'ssoSessionIdleTimeout': 300,
        'ssoSessionMaxLifespan': 900, 'bruteForceProtected': True,
        'webAuthnPolicyPasswordlessRpEntityName': 'HeavenKey',
        'webAuthnPolicyPasswordlessRpId': 'localhost',
        'webAuthnPolicyPasswordlessSignatureAlgorithms': ['ES256'],
        'webAuthnPolicyPasswordlessAttestationConveyancePreference': 'none',
        'webAuthnPolicyPasswordlessAuthenticatorAttachment': 'not specified',
        'webAuthnPolicyPasswordlessResidentKey': 'required',
        'webAuthnPolicyPasswordlessUserVerificationRequirement': 'required',
        'webAuthnPolicyPasswordlessAvoidSameAuthenticatorRegister': False,
    }, admin_token)
    # Copy the installed version's standard registration flow; remove password creation.
    admin('/authentication/flows/registration/copy', 'POST', {'newName': 'heavenkey-registration'})
    executions = admin('/authentication/flows/heavenkey-registration/executions')
    password_actions = [e for e in executions if e.get('providerId') == 'registration-password-action']
    if len(password_actions) != 1:
        raise RuntimeError('registration_password_action_not_identified')
    for execution in password_actions:
        execution['requirement'] = 'DISABLED'
        admin('/authentication/flows/heavenkey-registration/executions', 'PUT', execution)
    actions = admin('/authentication/required-actions')
    action = next(a for a in actions if a['alias'] == 'webauthn-register-passwordless')
    action.update(enabled=True, defaultAction=True)
    admin('/authentication/required-actions/webauthn-register-passwordless', 'PUT', action)

    # Both executions are alternatives: an existing SSO cookie or a user-verified passkey.
    admin('/authentication/flows', 'POST', {
        'alias': 'heavenkey-browser', 'description': 'Passkey-only local pilot',
        'providerId': 'basic-flow', 'topLevel': True, 'builtIn': False,
    })
    for provider in ['auth-cookie', 'webauthn-authenticator-passwordless']:
        admin('/authentication/flows/heavenkey-browser/executions/execution', 'POST', {'provider': provider})
    for execution in admin('/authentication/flows/heavenkey-browser/executions'):
        execution['requirement'] = 'ALTERNATIVE'
        admin('/authentication/flows/heavenkey-browser/executions', 'PUT', execution)
    admin('', 'PUT', {'browserFlow': 'heavenkey-browser', 'registrationFlow': 'heavenkey-registration'})

    for client_id, host, port in [('heavenkey-office-demo', 'office.localhost', 18371),
                                  ('heavenkey-portal-demo', 'portal.localhost', 18372)]:
        origin = f'http://{host}:{port}'
        admin('/clients', 'POST', {
            'clientId': client_id, 'enabled': True, 'protocol': 'openid-connect',
            'publicClient': False, 'secret': client_secrets[client_id],
            'standardFlowEnabled': True, 'implicitFlowEnabled': False,
            'directAccessGrantsEnabled': False, 'serviceAccountsEnabled': False,
            'redirectUris': [origin + '/callback'], 'webOrigins': [],
            'fullScopeAllowed': False, 'defaultClientScopes': [], 'optionalClientScopes': [],
            'attributes': {'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': origin + '/'},
            'protocolMappers': [{
                'name': 'HeavenKey pairwise subject', 'protocol': 'openid-connect',
                'protocolMapper': mapper_id, 'consentRequired': False,
                'config': {'pairwiseSubAlgorithmSalt': base64.b64encode(secrets.token_bytes(32)).decode()},
            }],
        })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keycloak-home', type=Path, default=os.environ.get('KEYCLOAK_HOME'))
    parser.add_argument('--e2e', action='store_true')
    parser.add_argument('--seconds', type=int, default=900)
    args = parser.parse_args()
    if not 60 <= args.seconds <= 3600:
        parser.error('--seconds must be between 60 and 3600')
    if not args.keycloak_home or not (args.keycloak_home / 'bin/kc.sh').is_file():
        parser.error('Set KEYCLOAK_HOME to the verified Keycloak 26.8.1 distribution; see apps/identity-pilot/README.md')
    if not shutil.which('node') or not (APP / 'node_modules/openid-client').is_dir():
        parser.error('Node 24+ and npm ci --prefix apps/identity-pilot are required')
    version = subprocess.check_output([str(args.keycloak_home / 'bin/kc.sh'), '--version'], text=True, timeout=30)
    if 'Keycloak 26.8.1' not in version:
        parser.error('This pilot requires the reviewed Keycloak 26.8.1 distribution')
    # Refuse a pre-existing listener instead of reusing another process or its identity state.
    for port in (18370, 18371, 18372):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    processes = []
    deadline = time.monotonic() + args.seconds

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with tempfile.TemporaryDirectory(prefix='heavenkey-identity-') as directory:
        runtime = Path(directory)
        os.chmod(runtime, 0o700)
        admin_name = 'pilot-' + secrets.token_hex(8)
        admin_password = secrets.token_urlsafe(32)
        client_secrets = {name: secrets.token_urlsafe(48) for name in
                          ('heavenkey-office-demo', 'heavenkey-portal-demo')}
        configuration = runtime / 'clients.json'
        configuration.write_text(json.dumps({'clientSecrets': client_secrets}))
        configuration.chmod(0o600)
        clean_environment = {key: value for key, value in os.environ.items()
                             if not key.startswith(('KC_', 'KCRAW_')) and key != 'HEAVENKEY_PILOT_CONFIG'}
        environment = dict(clean_environment, KC_BOOTSTRAP_ADMIN_USERNAME=admin_name,
                           KC_BOOTSTRAP_ADMIN_PASSWORD=admin_password,
                           JAVA_OPTS_APPEND='-Xms128m -Xmx512m -XX:ActiveProcessorCount=2',
                           HEAVENKEY_PILOT_CONFIG=str(configuration))
        try:
            with (runtime / 'keycloak.log').open('w') as log:
                processes.append(subprocess.Popen([
                    str(args.keycloak_home / 'bin/kc.sh'), 'start-dev', '--http-host=127.0.0.1',
                    '--http-port=18370', '--http-management-host=127.0.0.1', '--hostname=' + BASE,
                    '--db=dev-file', '--metrics-enabled=false',
                    '--db-url=jdbc:h2:file:' + str(runtime / 'keycloak-db') + ';NON_KEYWORDS=VALUE;DB_CLOSE_ON_EXIT=FALSE',
                    '--health-enabled=false',
                ], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
                token_response = None
                startup_deadline = min(deadline, time.monotonic() + 120)
                while time.monotonic() < startup_deadline:
                    if processes[0].poll() is not None:
                        diagnostic = (runtime / 'keycloak.log').read_text()[-6000:]
                        for value in [admin_password, *client_secrets.values()]:
                            diagnostic = diagnostic.replace(value, '[redacted]')
                        raise RuntimeError(f'keycloak_start_failed ({processes[0].returncode}): ' + diagnostic)
                    try:
                        token_response = request('/realms/master/protocol/openid-connect/token', 'POST', {
                            'client_id': 'admin-cli', 'grant_type': 'password',
                            'username': admin_name, 'password': admin_password,
                        }, encoded=True)
                        break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.4)
                if not token_response:
                    raise RuntimeError('keycloak_start_timeout')
                configure(token_response['access_token'], client_secrets)
                # Do not pass bootstrap credentials to the relying parties or browser tests.
                child_environment = dict(clean_environment, HEAVENKEY_PILOT_CONFIG=str(configuration))
                processes.append(subprocess.Popen(['node', str(APP / 'server.mjs')],
                                                  env=child_environment, start_new_session=True))
                for _ in range(50):
                    try:
                        probe = urllib.request.Request('http://127.0.0.1:18371/health', headers={'Host': 'office.localhost:18371'})
                        with HTTP.open(probe, timeout=2) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        time.sleep(0.2)
                else:
                    raise RuntimeError('relying_party_start_timeout')
                print('Local passkey pilot ready. Only synthetic accounts; Ctrl+C removes its temporary data.', flush=True)
                if args.e2e:
                    command = ['node', str(APP / 'e2e.mjs')]
                    browser_test = subprocess.Popen(command, env=clean_environment, start_new_session=True)
                    processes.append(browser_test)
                    code = browser_test.wait(timeout=max(1, deadline - time.monotonic()))
                    if code:
                        raise subprocess.CalledProcessError(code, command)
                else:
                    while time.monotonic() < deadline:
                        if any(p.poll() is not None for p in processes):
                            raise RuntimeError('pilot_process_exited')
                        time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
            for process in reversed(processes):
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


if __name__ == '__main__':
    main()
