from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
license_text = (root/'docs/licenses/simplewebauthn-browser-MIT.txt').read_text()
subprocess.run(
    ['bun', 'build', 'apps/web/src/main.ts', '--outdir', 'apps/web/dist',
     '--target', 'browser', '--banner', '/*! @simplewebauthn/browser 14.0.0\n'+license_text+'*/'],
    cwd=root, check=True,
)
