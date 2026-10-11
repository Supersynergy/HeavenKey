from pathlib import Path
from datetime import datetime, timezone
import json
import os
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parent.parent
name, seconds, *command = sys.argv[1:]
if command and command[0] == '--':
    command = command[1:]
timeout = min(float(seconds), 7200)
if deadline_value := os.environ.get('HEAVENKEY_DEADLINE_UTC'):
    deadline = datetime.fromisoformat(deadline_value)
    timeout = min(timeout, (deadline - datetime.now(timezone.utc)).total_seconds())
if timeout <= 0:
    raise SystemExit('foreground command deadline exceeded')
env = dict(os.environ, CARGO_BUILD_JOBS='4', CARGO_TERM_COLOR='never', RUSTC_WRAPPER='', CARGO_TARGET_DIR=str(root/'target'))
start = time.monotonic()
logfile = root/'docs/evidence'/f'{name}.log'

def kill_tree(pid):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True, timeout=5)
    parents = {int(p):int(parent) for p,parent in (row.split() for row in rows.splitlines())}
    ordered = [pid]
    for parent in ordered:
        ordered.extend(p for p,ppid in parents.items() if ppid == parent and p not in ordered)
    for owned in reversed(ordered):
        try:
            os.kill(owned, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return ordered

cleanup_pids = []
with logfile.open('w') as log:
    child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            cleanup_pids = kill_tree(child.pid)
        except subprocess.SubprocessError:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        code = 124
event = {'name':name,'command':command,'exit_code':code,'elapsed_seconds':round(time.monotonic()-start,3),'time_utc':datetime.now(timezone.utc).isoformat(),'log':str(logfile),'timeout_cleanup_pids':cleanup_pids}
with (root/'docs/evidence/commands.jsonl').open('a') as ledger:
    ledger.write(json.dumps(event)+'\n')
print(json.dumps(event))
if code:
    print('\n'.join(logfile.read_text().splitlines()[-60:]))
raise SystemExit(code)
