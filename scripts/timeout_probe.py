from pathlib import Path
import subprocess
import sys

child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
Path('docs/evidence/timeout-child.pid').write_text(str(child.pid))
child.wait()
