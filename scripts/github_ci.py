"""Run one approved commit on a bounded, isolated GitHub runner without hosted compute/storage."""

from pathlib import Path
import argparse
import fcntl
import hashlib
import json
import re
import signal
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".ci-runner"
REPO = "Supersynergy/HeavenKey"
BASE = "catthehacker/ubuntu@sha256:c58e2b364da03b0c804c7d660f2ecbedf2f221a382b9baa0b344b0144780ff43"
ARCHIVES = (
    (
        "actions/runner",
        "v2.338.0",
        "actions-runner-linux-arm64-2.338.0.tar.gz",
        "628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b",
    ),
    (
        "oven-sh/bun",
        "bun-v1.4.2",
        "bun-linux-aarch64.zip",
        "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7",
    ),
    (
        "EmbarkStudios/cargo-deny",
        "0.20.2",
        "cargo-deny-0.20.2-aarch64-unknown-linux-musl.tar.gz",
        "995c82be0defc7a025cae49a2aa2644ce8245c9a3318fc4103907c6a285e8c7d",
    ),
    (
        "rustsec/rustsec",
        "cargo-audit/v0.22.2",
        "cargo-audit-aarch64-unknown-linux-gnu-v0.22.2.tgz",
        "c6603814ddaa45e51263dafd31c0ac98808f688d26f7395804f9670b0fd599dd",
    ),
)


def command(args, *, seconds=30, data=None, check=True):
    return subprocess.run(
        args,
        cwd=ROOT,
        input=data,
        text=True,
        capture_output=True,
        timeout=seconds,
        check=check,
    )


def api(path, *, method="GET", data=None):
    args = ["gh", "api", "--method", method, path]
    if data is not None:
        args += ["--input", "-"]
    result = command(args, data=json.dumps(data) if data is not None else None)
    return json.loads(result.stdout) if result.stdout.strip() else None


def write_state(data):
    temporary = STATE / "session.tmp"
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.replace(STATE / "session.json")


def remove_container(name):
    result = command(["docker", "rm", "-f", name], check=False)
    if result.returncode and "No such container" not in result.stderr:
        raise RuntimeError(result.stderr)


def attached_container(args, name, log, seconds):
    with log.open("w") as output:
        child = subprocess.Popen(
            args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT
        )
        try:
            code = child.wait(timeout=seconds)
        finally:
            if child.poll() is None:
                remove_container(name)
                child.wait(timeout=10)
    if code:
        raise RuntimeError(f"Container exited {code}; inspect {log}")


def prepare_image():
    sources = (
        "scripts/ci/prepare_image.sh",
        "scripts/ci/runner_entry.sh",
        "package.json",
        "bun.lock",
        "apps/web/package.json",
    )
    digest = hashlib.sha256(
        BASE.encode() + b"".join((ROOT / p).read_bytes() for p in sources)
    ).hexdigest()[:16]
    image = f"heavenkey-ci:{digest}"
    if command(["docker", "image", "inspect", image], check=False).returncode == 0:
        return image
    archive = STATE / "downloads"
    archive.mkdir(exist_ok=True)
    for repo, tag, filename, checksum in ARCHIVES:
        path = archive / filename
        if not path.exists():
            command(
                [
                    "gh",
                    "release",
                    "download",
                    tag,
                    "-R",
                    repo,
                    "-p",
                    filename,
                    "-D",
                    str(archive),
                ],
                seconds=120,
            )
        if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise RuntimeError(f"Archive checksum mismatch: {filename}")
    name = "heavenkey-image-" + uuid.uuid4().hex[:12]
    write_state({"phase": "image", "container": name, "active": True})
    print(
        json.dumps(
            {
                "phase": "prepare-image",
                "cpus": 4,
                "memory_gib": 6,
                "timeout_seconds": 900,
            }
        ),
        flush=True,
    )
    try:
        args = [
            "docker",
            "run",
            "--pull=never",
            "--name",
            name,
            "--cpus=4",
            "--memory=6g",
            "--pids-limit=512",
            "-v",
            f"{archive}:/archive:ro",
            "-v",
            f"{ROOT}:/source:ro",
            BASE,
            "bash",
            "/source/scripts/ci/prepare_image.sh",
        ]
        attached_container(args, name, STATE / "image.log", 900)
        command(
            [
                "docker",
                "commit",
                "--change",
                "USER heavenkey",
                "--change",
                "WORKDIR /opt/heavenkey/runner",
                "--change",
                "ENV PLAYWRIGHT_BROWSERS_PATH=/opt/heavenkey/browsers",
                name,
                image,
            ],
            seconds=120,
        )
    finally:
        remove_container(name)
        write_state({"phase": "image", "active": False})
    return image


def validate_evidence(evidence, sha, run_id):
    manifest = json.loads((evidence / "manifest.json").read_text())
    if manifest["head_commit"] != sha or str(manifest["run_id"]) != str(run_id):
        raise RuntimeError("Evidence belongs to another commit or run")
    required = {
        "e2e.json",
        "ci-source.log",
        "ci-security.log",
        "ci-build.log",
        "ci-e2e.log",
        "commands.jsonl",
    }
    if not required.issubset(manifest["files"]):
        raise RuntimeError("Required CI evidence is missing")
    for name, checksum in manifest["files"].items():
        if (
            Path(name).name != name
            or hashlib.sha256((evidence / name).read_bytes()).hexdigest() != checksum
        ):
            raise RuntimeError("Evidence checksum mismatch")
    browser = json.loads((evidence / "e2e.json").read_text())
    if (
        not browser["completed"]
        or browser["failed"]
        or browser["total"] < 138
        or browser["passed"] != browser["total"]
    ):
        raise RuntimeError("Browser acceptance did not pass")
    source = (evidence / "ci-source.log").read_text()
    rust = sum(map(int, re.findall(r"test result: ok\. (\d+) passed", source)))
    reference = [
        json.loads(line).get("passed", 0)
        for line in source.splitlines()
        if line.startswith("{")
    ]
    if rust < 45 or max(reference, default=0) < 75:
        raise RuntimeError("Rust/reference acceptance is incomplete")
    return {"rust": rust, "reference": max(reference), "browser": browser["passed"]}


def check_image_access(image):
    command(
        [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--cpus=1",
            "--memory=512m",
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            image,
            "python3",
            "-c",
            "from pathlib import Path\nimport os\n"
            'if os.getuid()!=501: raise RuntimeError("Runner must be unprivileged")\n'
            'p=Path("/opt/heavenkey/runner/_diag/.write-probe"); '
            'p.write_text("ok"); p.unlink()',
        ]
    )


def select_queued_run(runs):
    for run in runs:
        if run["path"] != ".github/workflows/ci.yml" or run["status"] == "completed":
            continue
        jobs = api(f"repos/{REPO}/actions/runs/{run['id']}/jobs")["jobs"]
        if any(job["status"] == "queued" for job in jobs):
            return run
        if any(job["status"] == "in_progress" for job in jobs):
            raise RuntimeError("An approved CI job is already running; preserve it")
    return None


def run_ci(image):
    if command(["git", "status", "--porcelain", "--untracked-files=no"]).stdout:
        raise RuntimeError(
            "Commit and publish the reviewed source before starting the runner"
        )
    sha = command(["git", "rev-parse", "HEAD"]).stdout.strip()
    branch = command(["git", "branch", "--show-current"]).stdout.strip()
    metadata = api(f"repos/{REPO}")
    if not metadata["private"] or not metadata["permissions"]["admin"]:
        raise RuntimeError(
            "Runner requires this private repository and its admin authorization"
        )
    if api(f"repos/{REPO}/commits/{sha}")["sha"] != sha:
        raise RuntimeError("Commit is not published")
    check_image_access(image)
    runs = api(f"repos/{REPO}/actions/runs?head_sha={sha}&per_page=20")["workflow_runs"]
    run = select_queued_run(runs)
    if run is None:
        command(["gh", "workflow", "run", "ci.yml", "-R", REPO, "--ref", branch])
        for _ in range(10):
            time.sleep(2)
            runs = api(f"repos/{REPO}/actions/runs?head_sha={sha}&per_page=20")[
                "workflow_runs"
            ]
            run = select_queued_run(runs)
            if run is not None:
                break
    if run is None:
        raise RuntimeError("No queued CI run for the approved commit")
    name = "heavenkey-ci-" + uuid.uuid4().hex[:12]
    evidence = STATE / f"evidence-{run['id']}"
    evidence.mkdir(exist_ok=True)
    state = {
        "phase": "runner",
        "container": name,
        "run_id": run["id"],
        "head": sha,
        "active": True,
    }
    write_state(state)
    runner_id = None
    try:
        data = api(
            f"repos/{REPO}/actions/runners/generate-jitconfig",
            method="POST",
            data={
                "name": name,
                "runner_group_id": 1,
                "labels": [
                    "self-hosted",
                    "Linux",
                    "ARM64",
                    f"heavenkey-ci-{sha}-{run['id']}",
                ],
                "work_folder": "_work",
            },
        )
        runner_id = data["runner"]["id"]
        state["runner_id"] = runner_id
        write_state(state)
        with tempfile.TemporaryDirectory(prefix="jit-", dir=STATE) as temporary:
            config = Path(temporary) / "config.json"
            config.write_text(
                json.dumps({"encoded_jit_config": data["encoded_jit_config"]})
            )
            config.chmod(0o600)
            mounts = ["-v", f"{temporary}:/jit:ro", "-v", f"{evidence}:/evidence"]
            for folder, destination in (
                ("cargo", "/home/heavenkey/.cargo"),
                ("rustup", "/home/heavenkey/.rustup"),
                ("target", "/cache/target"),
            ):
                path = STATE / folder
                path.mkdir(exist_ok=True)
                mounts += ["-v", f"{path}:{destination}"]
            args = [
                "docker",
                "run",
                "--rm",
                "--pull=never",
                "--name",
                name,
                "--cpus=4",
                "--memory=6g",
                "--pids-limit=512",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                *mounts,
                image,
                "bash",
                "entry.sh",
            ]
            print(
                json.dumps(
                    {
                        "phase": "runner",
                        "run_url": run["html_url"],
                        "head": sha,
                        "runner_id": runner_id,
                    }
                ),
                flush=True,
            )
            attached_container(args, name, STATE / f"runner-{run['id']}.log", 1800)
    finally:
        remove_container(name)
        if runner_id is not None:
            removal = command(
                [
                    "gh",
                    "api",
                    "--method",
                    "DELETE",
                    f"repos/{REPO}/actions/runners/{runner_id}",
                ],
                check=False,
            )
            if removal.returncode and "404" not in removal.stderr:
                raise RuntimeError("Runner removal failed; inspect session.json")
        state["active"] = False
        write_state(state)
    result = api(f"repos/{REPO}/actions/runs/{run['id']}")
    for _ in range(10):
        if result["status"] == "completed":
            break
        time.sleep(2)
        result = api(f"repos/{REPO}/actions/runs/{run['id']}")
    (evidence / "github-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                "conclusion": result["conclusion"],
                "run_url": result["html_url"],
                "evidence": str(evidence),
            }
        )
    )
    if result["conclusion"] != "success":
        raise RuntimeError("GitHub CI did not pass; see preserved evidence")
    print(json.dumps({"acceptance": validate_evidence(evidence, sha, run["id"])}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "runner.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = STATE / "session.json"
        if previous.exists() and json.loads(previous.read_text()).get("active"):
            raise RuntimeError(
                "Interrupted session detected; inspect session.json and its owned runner/container first"
            )
        image = prepare_image()
        if not args.prepare_only:
            run_ci(image)


if __name__ == "__main__":

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    main()
