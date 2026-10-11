from pathlib import Path
import json
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='heavenkey-startup-probe-') as directory:
    start = time.monotonic()
    result = subprocess.run(
        ['bun', str(root/'scripts/e2e.mjs')], cwd=directory,
        capture_output=True, text=True, timeout=10,
    )
    report = json.loads((Path(directory)/'docs/evidence/e2e.json').read_text())
    evidence = {
        'exit_code': result.returncode,
        'elapsed_seconds': round(time.monotonic()-start, 2),
        'completed': report['completed'],
        'fatal_error': report.get('fatal_error'),
        'passed': result.returncode == 1 and not report['completed']
            and 'spawn failed' in report.get('fatal_error', ''),
    }
    (root/'docs/evidence/heavenkey-missing-binary.json').write_text(json.dumps(evidence, indent=2)+'\n')
    print(json.dumps(evidence))
    if not evidence['passed']:
        raise SystemExit('missing-binary regression failed')
