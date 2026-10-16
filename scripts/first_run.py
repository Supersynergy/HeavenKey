"""Build and launch the checked-out preview without requiring just or Docker."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--lab", action="store_true", help="Start the separate passkey access lab")
    parser.add_argument("--port", type=int, default=18240)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--protection-key-file", type=Path)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    missing = [name for name in ("cargo", "bun") if not shutil.which(name)]
    if missing:
        print("Install these tools first: " + ", ".join(missing))
        print("Rust: https://rustup.rs/\nBun 1.4.2: https://bun.sh/docs/installation")
        return 1
    version = subprocess.check_output(
        ["bun", "--version"], text=True, timeout=15
    ).strip()
    if version != "1.4.2":
        print(f"Bun 1.4.2 is required; installed: {version}")
        return 1
    print("Required tools available. Rustup selects the repository's pinned toolchain.")
    if args.check_only:
        return 0
    env = os.environ.copy()
    if args.protection_key_file:
        from create_protection_key import create

        path = args.protection_key_file.expanduser().absolute()
        if not path.exists():
            create(path)
        env["HEAVENKEY_KEY_FILE"] = str(path)
    for command, timeout in (
        (["bun", "install", "--frozen-lockfile", "--ignore-scripts"], 180),
        (["cargo", "fetch", "--locked"], 300),
        ([sys.executable, "scripts/build_web.py"], 120),
        (["cargo", "build", "--locked", "--offline"], 900),
    ):
        print("Running: " + " ".join(command), flush=True)
        subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=timeout)
    binary = ROOT / "target/debug" / ("uac-api.exe" if os.name == "nt" else "uac-api")
    command = [str(binary), "--port", str(args.port)]
    if not args.lab:
        command.append("--password-manager")
    if not args.no_open:
        command.append("--open")
    if args.data_dir:
        command += ["--data-dir", str(args.data_dir)]
    print("HeavenKey starts in this terminal. Stop with Ctrl+C.", flush=True)
    return subprocess.call(command, cwd=ROOT, env=env)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
        print(f"Setup stopped: {error}", file=sys.stderr)
        print("See docs/INSTALLATION.md for the matching solution.", file=sys.stderr)
        raise SystemExit(1)
