from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
license_text = (root/'docs/licenses/simplewebauthn-browser-MIT.txt').read_text()
subprocess.run(
    ['bun', 'build', 'apps/web/src/main.ts', '--outdir', 'apps/web/dist',
     '--target', 'browser', '--banner', '/*! @simplewebauthn/browser 14.0.0\n'+license_text+'*/'],
    cwd=root, check=True,
)
subprocess.run(
    ['bun', 'build', 'apps/web/src/passwords.ts', '--outdir', 'apps/web/dist', '--target', 'browser'],
    cwd=root, check=True,
)
subprocess.run(['bun', 'build', 'apps/web/src/share.ts', '--outdir', 'apps/web/dist', '--target', 'browser'], cwd=root, check=True)
subprocess.run(['bun', 'scripts/build_extension.ts'], cwd=root, check=True)
