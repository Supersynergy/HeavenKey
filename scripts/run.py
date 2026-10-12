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

def process_snapshot(limit=5):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True, timeout=limit)
    parents = {int(p):int(parent) for p,parent in (row.split() for row in rows.splitlines())}
    if parents.get(os.getpid()) != os.getppid():
        raise ValueError('process snapshot does not contain the wrapper')
    return parents

def kill_tree(pid):
    ordered = [pid]
    try:
        # Stop parents before discovering children, including detached sessions.
        try:
            os.killpg(pid, signal.SIGSTOP)
        except ProcessLookupError:
            pass
        for _ in range(3):
            parents = process_snapshot()
            previous = len(ordered)
            for parent in ordered:
                ordered.extend(p for p,ppid in parents.items() if ppid == parent and p not in ordered)
                try:
                    os.kill(parent, signal.SIGSTOP)
                except ProcessLookupError:
                    pass
            if len(ordered) == previous:
                break
    finally:
        for owned in reversed(ordered):
            try:
                os.kill(owned, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return ordered

class CommandInterrupted(Exception):
    pass

interrupted_signal = None
waiting = False

def interrupt(signum, _frame):
    global interrupted_signal
    if interrupted_signal is not None:
        return
    interrupted_signal = signum
    if waiting:
        raise CommandInterrupted

signal.signal(signal.SIGINT, interrupt)
signal.signal(signal.SIGTERM, interrupt)
cleanup_pids = []
cleanup_error = None
termination = None
child = None
with logfile.open('w') as log:
    try:
        # Refuse work when detached-descendant cleanup cannot take a snapshot.
        process_snapshot(min(5, timeout))
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        code = 125
        cleanup_error = 'process_tree_preflight_failed'
        print(f'process snapshot preflight failed: {error}', file=log)
    else:
        if interrupted_signal:
            code = 128 + interrupted_signal
        elif time.monotonic() - start >= timeout:
            termination = 'timeout'
            code = 124
        else:
            child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    if child is not None:
        try:
            waiting = True
            try:
                if interrupted_signal:
                    raise CommandInterrupted
                code = child.wait(timeout=max(0, timeout - (time.monotonic() - start)))
            finally:
                waiting = False
        except (subprocess.TimeoutExpired, CommandInterrupted, KeyboardInterrupt) as error:
            waiting = False
            termination = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else 'interrupted'
            code = 124 if termination == 'timeout' else 128 + (interrupted_signal or signal.SIGINT)
            try:
                cleanup_pids = kill_tree(child.pid)
            except (OSError, subprocess.SubprocessError, ValueError):
                cleanup_error = 'process_tree_snapshot_failed'
            child.wait(timeout=5)
        finally:
            waiting = False
if interrupted_signal and termination != 'timeout':
    code = 128 + interrupted_signal
event = {'name':name,'command':command,'exit_code':code,'elapsed_seconds':round(time.monotonic()-start,3),'time_utc':datetime.now(timezone.utc).isoformat(),'log':str(logfile),'timeout_cleanup_pids':cleanup_pids if termination == 'timeout' else [],'interruption_cleanup_pids':cleanup_pids if termination == 'interrupted' else [],'interrupted_signal':signal.Signals(interrupted_signal).name if interrupted_signal else None,'cleanup_error':cleanup_error,'process_started':child is not None}
with (root/'docs/evidence/commands.jsonl').open('a') as ledger:
    ledger.write(json.dumps(event)+'\n')
print(json.dumps(event))
if code:
    print('\n'.join(logfile.read_text().splitlines()[-60:]))
raise SystemExit(code)
