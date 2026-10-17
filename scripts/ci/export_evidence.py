from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess

source = Path("docs/evidence")
destination = Path("/evidence")
destination.mkdir(parents=True, exist_ok=True)
files = {}
for pattern in (
    "ci-*.log",
    "commands.jsonl",
    "e2e.json",
    "heavenkey-missing-binary.json",
    "browser-*.png",
    "failure-diagnostic.json",
    "failure-*.png",
):
    for path in source.glob(pattern):
        shutil.copyfile(path, destination / path.name)
        files[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
extension_receipt = Path("apps/extension/TEST-RECEIPT.json")
if extension_receipt.exists():
    name = "extension-autofill.json"
    shutil.copyfile(extension_receipt, destination / name)
    files[name] = hashlib.sha256(extension_receipt.read_bytes()).hexdigest()
access_receipt = source / "password-access/browser.json"
if access_receipt.exists():
    name = "password-access.json"
    shutil.copyfile(access_receipt, destination / name)
    files[name] = hashlib.sha256(access_receipt.read_bytes()).hexdigest()
broker_receipt = source / "password-broker/browser.json"
if broker_receipt.exists():
    name = "password-broker.json"
    shutil.copyfile(broker_receipt, destination / name)
    files[name] = hashlib.sha256(broker_receipt.read_bytes()).hexdigest()
(destination / "manifest.json").write_text(
    json.dumps(
        {
            "source_commit": os.environ.get("GITHUB_SHA"),
            "head_commit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], text=True, timeout=10
            ).strip(),
            "run_id": os.environ.get("GITHUB_RUN_ID"),
            "files": files,
        },
        indent=2,
    )
    + "\n"
)
print(f"Preserved {len(files)} fresh evidence files locally")
