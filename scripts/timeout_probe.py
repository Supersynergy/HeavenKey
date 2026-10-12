from pathlib import Path
import subprocess
import sys

child_code = """
from pathlib import Path
import subprocess
import sys

grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
Path('docs/evidence/timeout-grandchild.pid').write_text(str(grandchild.pid))
grandchild.wait()
"""
child = subprocess.Popen([sys.executable, '-c', child_code], start_new_session=True)
Path('docs/evidence/timeout-child.pid').write_text(str(child.pid))
child.wait()
