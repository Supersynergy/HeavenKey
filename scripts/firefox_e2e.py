"""Firefox UI + extension acceptance using disposable WebDriver virtual authenticators."""
import base64
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = 'http://localhost:18247'
OUT = ROOT / 'docs/images/screenshots'
EVIDENCE = ROOT / 'docs/evidence'
ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'


def http(url, method='GET', body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={'Content-Type':'application/json', **({'Origin':ORIGIN} if url.startswith(ORIGIN + '/') else {})})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}: {error.read().decode()[:1000]}') from error


def wait(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.05)
    raise RuntimeError('Firefox UI wait timed out')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    cases = []
    with tempfile.TemporaryDirectory(prefix='heavenkey-firefox-ui-') as temporary:
        temp = Path(temporary)
        key = temp / 'protection.key'; key.write_bytes(os.urandom(32)); key.chmod(0o600)
        data = temp / 'data'
        env = dict(os.environ, HEAVENKEY_KEY_FILE=str(key), HEAVENKEY_ORIGIN=ORIGIN, HEAVENKEY_RP_ID="localhost")
        binary = Path(env.get('HEAVENKEY_BINARY', ROOT / 'target/debug/uac-api')).resolve()
        driver_path = env.get('GECKODRIVER_PATH', 'geckodriver')
        firefox = env.get('FIREFOX_PATH', 'firefox')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        base = f'http://localhost:{port}'
        server = driver = None; session_id = None; passed = False
        with (temp/'api.log').open('w') as api_log, (temp/'webdriver.log').open('w') as driver_log:
            try:
                server = subprocess.Popen([str(binary),'--data-dir',str(data),'--port','18247'],env=env,stdout=api_log,stderr=api_log)
                def server_ready():
                    if server.poll() is not None: raise RuntimeError((temp/'api.log').read_text())
                    try:return http(ORIGIN+'/health').get('status')=='ok'
                    except (OSError,RuntimeError):return False
                wait(server_ready)
                driver = subprocess.Popen([driver_path,'--host','127.0.0.1','--port',str(port)],env=env,stdout=driver_log,stderr=driver_log)
                def driver_ready():
                    if driver.poll() is not None:raise RuntimeError((temp/'webdriver.log').read_text())
                    try:return http(base+'/status').get('value',{}).get('ready')
                    except OSError:return False
                wait(driver_ready)
                extension_uuid = 'c58d4770-783f-4ccf-b511-32ed00d01d6b'
                created = http(base+'/session','POST',{'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{'binary':firefox,'args':['-headless'],'prefs':{'extensions.webextensions.uuids':json.dumps({'heavenkey@supersynergy.local':extension_uuid}),'browser.download.folderList':2,'browser.download.dir':str(temp/'downloads'),'browser.helperApps.neverAsk.saveToDisk':'application/json'}}}}})['value']
                session_id = created['sessionId']; root = base+'/session/'+session_id
                def command(path,body=None,method=None):return http(root+path,method or ('GET' if body is None else 'POST'),body).get('value')
                def js(source,*args):return command('/execute/sync',{'script':source,'args':list(args)})
                def text(identity):return js('return document.getElementById(arguments[0]).textContent;',identity)
                def click(identity):
                    found=command('/element',{'using':'css selector','value':'#'+identity})
                    command('/element/'+found[ELEMENT]+'/click',{})
                def fill(identity,value):js('const e=document.getElementById(arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));',identity,value)
                def ready():return js('return document.documentElement.dataset.ready === "true";')
                def screenshot(name,section=None):
                    if section:js('document.getElementById(arguments[0]).scrollIntoView({block:"start"});',section)
                    time.sleep(.1)
                    (OUT/name).write_bytes(base64.b64decode(command('/screenshot')))
                def case(name):cases.append({'name':name,'pass':True});print('PASS '+name,flush=True)
                options={'protocol':'ctap2','transport':'internal','hasResidentKey':True,'hasUserVerification':True,'isUserConsenting':True,'isUserVerified':True}
                auth=command('/webauthn/authenticator',options)
                command('/window/rect',{'width':1360,'height':1000})
                command('/url',{'url':ORIGIN});wait(ready)
                assert js('return isSecureContext && typeof PublicKeyCredential === "function";')
                assert not js('return document.documentElement.scrollWidth > innerWidth;')
                screenshot('firefox-01-start.png')
                case('Firefox loads the actual interface without horizontal overflow')
                fill('bootstrap',(data/'owner-bootstrap.txt').read_text().strip())
                click('register');wait(lambda:'eingeschrieben' in text('status'))
                click('login');wait(lambda:'Eigentümer' in text('identity'))
                wait(lambda:not js('return document.getElementById("recovery-rotate").disabled;'))
                case('Native navigator.credentials registration and login pass the Rust verifier')
                click('recovery-rotate');wait(lambda:js('return document.getElementById("management-dialog").open;'))
                screenshot('firefox-02-confirmation.png')
                click('management-confirm');wait(lambda:'Neuer Einmalcode' in text('recovery-created'))
                click('recovery-download')
                kit_path=wait(lambda:next((temp/'downloads').glob('heavenkey-recovery-*.json'),None))
                kit=json.loads(kit_path.read_text());assert kit['account_recovery_code'].startswith('hk-recovery-v1.')
                screenshot('firefox-03-recovery.png','recovery')
                case('Exact-action passkey confirmation creates and downloads the recovery kit')
                fill('credential-label','Virtueller Ersatz-Passkey');click('credential-add')
                wait(lambda:js('return document.getElementById("management-dialog").open;'));click('management-confirm')
                wait(lambda:'hinzugefügt' in text('status'))
                case('A second virtual passkey is added through the actual interface')
                runtime=shutil.which('node') or shutil.which('bun')
                if not runtime: raise RuntimeError('Node.js or Bun is required for the agent example')
                agent_file=temp/'agent.pem'
                generated=json.loads(subprocess.check_output([runtime,str(ROOT/'scripts/agent.mjs'),'keygen',str(agent_file)],text=True,timeout=10))
                public=generated['public_key']
                fill('agent-public',public);fill('agent-name','Hotel-Assistent · Beispiel')
                click('agent-create');wait(lambda:js('return document.getElementById("management-dialog").open;'));click('management-confirm')
                wait(lambda:'Agentenauftrag freigegeben' in text('status'))
                task=json.loads(text('result'))['task_id']
                invoked=json.loads(subprocess.check_output([runtime,str(ROOT/'scripts/agent.mjs'),'read',str(agent_file),task,'--origin',ORIGIN],text=True,timeout=15))
                assert invoked['allowed']
                screenshot('firefox-04-agents.png','agents')
                case('A browser-approved agent executes its proof-bound CRM read')
                # Current virtual-authenticator PRF support is tested without assuming it exists.
                fill('vault-text','Beispielnotiz für die lokale Vorschau.');click('vault-create')
                wait(lambda:not js('return document.getElementById("vault-create").hasAttribute("aria-busy");'))
                vault_status=text('status')
                if js('return document.getElementById("management-dialog").open;'):
                    click('management-confirm');wait(lambda:'Tresor erstellt' in text('status'))
                    prf='virtual-authenticator-prf-supported'
                else:
                    assert 'PRF' in vault_status or 'not supported' in vault_status, vault_status
                    prf='virtual-authenticator-prf-unavailable-normal-login-retained'
                case('The optional PRF path either completes or reports explicit capability limits')
                screenshot('firefox-05-vault.png','vault')
                addon=command('/moz/addon/install',{'path':str(ROOT/'dist/extension-firefox'),'temporary':True})
                assert addon=='heavenkey@supersynergy.local'
                command('/url',{'url':f'moz-extension://{extension_uuid}/popup.html'})
                wait(lambda:js('return Boolean(document.getElementById("open-form"));'))
                command('/window/rect',{'width':420,'height':900})
                fill('port','18247');fill('destination','keys')
                screenshot('firefox-06-extension.png')
                handles=command('/window/handles');js('document.querySelector("button[type=submit]").click();')
                wait(lambda:len(command('/window/handles'))>len(handles))
                new_handle=next(x for x in command('/window/handles') if x not in handles)
                saved=js('return JSON.parse(localStorage.getItem("heavenkey.connection.v1"));')
                assert saved['port']=='18247' and saved['destination']=='keys'
                assert js('return Object.keys(localStorage);')==['heavenkey.connection.v1']
                command('/window',{'handle':new_handle});wait(lambda:command('/url')==ORIGIN+'/#keys');wait(ready)
                assert text('identity')=='Noch nicht angemeldet'
                case('Firefox extension opens the chosen section and persists only connection settings')
                command('/webauthn/authenticator/'+auth,method='DELETE')
                command('/webauthn/authenticator',options)
                command('/window/rect',{'width':1360,'height':1000})
                fill('recovery-name','owner');fill('recovery-code',kit['account_recovery_code'])
                js('document.querySelector("#recovery details").open=true;')
                click('recovery-submit');wait(lambda:'Konto wiederhergestellt' in text('status'))
                click('login');wait(lambda:'Eigentümer' in text('identity'))
                wait(lambda:'Noch keine' not in text('credentials'))
                screenshot('firefox-07-recovered-keys.png','keys')
                assert 'Wiederhergestelltes Gerät' in text('credentials')
                case('Downloaded recovery code restores the account with a fresh virtual authenticator')
                command('/window/rect',{'width':390,'height':844})
                assert not js('return document.documentElement.scrollWidth > innerWidth;')
                screenshot('firefox-08-mobile.png','recovery')
                case('Recovery interface also fits a 390-pixel viewport')
                passed=True
                report={'pass':True,'browser':'Firefox','browser_version':created['capabilities']['browserVersion'],'driver':'geckodriver 0.37.1','authenticators':'virtual CTAP2; real navigator.credentials; real Rust verification','native_hardware':False,'signed_extension':False,'prf':prf,'cases':cases,'screenshots':sorted(p.name for p in OUT.glob('firefox-*.png'))}
                (EVIDENCE/'firefox-v07.json').write_text(json.dumps(report,indent=2)+'\n')
            finally:
                if session_id:
                    try:http(base+'/session/'+session_id,'DELETE')
                    except Exception:pass
                for process in (driver,server):
                    if process and process.poll() is None:
                        process.terminate()
                        try:process.wait(timeout=5)
                        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
                if not passed:
                    print((temp/'webdriver.log').read_text()[-3000:],flush=True)
                    (EVIDENCE/'firefox-v07-failure.json').write_text(json.dumps({'pass':False,'completed_cases':cases},indent=2)+'\n')


if __name__=='__main__':main()
