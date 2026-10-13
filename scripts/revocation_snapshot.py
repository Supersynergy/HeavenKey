"""Export the delegation revocation set as a uac-gate snapshot file.

The gate (apps/gate) reads a JSON snapshot per request:
{"version": 1, "generated_at": <unix seconds>, "revoked": ["<64-hex id>", ...]}.

This script produces that file from the local store. It either runs
`uac-api --store-query` itself or consumes an existing --store-query output.

Usage:
    python3 scripts/revocation_snapshot.py --data data --out revocations.json
    python3 scripts/revocation_snapshot.py --store-query-json rows.json --out revocations.json

Environment: UAC_STORE_KEY / UAC_STORE_KEY_FILE apply to the store query
exactly as for the API; UAC_API_BINARY overrides the binary path.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

STORE_QUERY = {"sql": "SELECT id FROM delegations WHERE revoked=1", "params": []}
MAX_ID_LENGTH = 64
MAX_ENTRIES = 65536


def query_ids(binary, data_dir):
    env = dict(os.environ)
    env["UAC_DATA"] = data_dir
    result = subprocess.run(
        [binary, "--store-query", json.dumps(STORE_QUERY)],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    if result.returncode != 0:
        raise SystemExit(f"store query failed: {result.stderr.strip() or result.stdout.strip()}")
    return parse_rows(result.stdout)


def parse_rows(text):
    rows = json.loads(text)
    if not isinstance(rows, list):
        raise SystemExit("store query did not return a row array")
    revoked = []
    for row in rows:
        if not isinstance(row, list) or len(row) != 1:
            raise SystemExit("delegations.id query must return one column per row")
        value = row[0]
        if isinstance(value, dict) and "blob_base64" in value:
            import base64
            value = base64.b64decode(value["blob_base64"]).hex()
        if not isinstance(value, str):
            raise SystemExit("delegations.id must be text or a single blob column")
        candidate = value.strip().lower()
        if len(candidate) != MAX_ID_LENGTH or any(c not in "0123456789abcdef" for c in candidate):
            raise SystemExit(f"delegations.id is not a 64-hex grant id: {value!r}")
        revoked.append(candidate)
    if len(revoked) > MAX_ENTRIES:
        raise SystemExit("revocation snapshot exceeds entry limit")
    return sorted(set(revoked))


def write_snapshot(path, revoked, generated_at):
    snapshot = {"version": 1, "generated_at": generated_at, "revoked": revoked}
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=directory, prefix=".revocations-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w") as stream:
            json.dump(snapshot, stream, indent=1, sort_keys=True)
            stream.write("\n")
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main(argv):
    args = {"--out": None, "--data": "data", "--store-query-json": None, "--binary": None}
    index = 0
    while index < len(argv):
        flag = argv[index]
        if flag not in args or index + 1 >= len(argv):
            raise SystemExit(f"unknown or incomplete flag: {flag}")
        args[flag] = argv[index + 1]
        index += 2
    if args["--out"] is None:
        raise SystemExit("--out PATH is required")
    if args["--store-query-json"]:
        with open(args["--store-query-json"], encoding="utf-8") as stream:
            revoked = parse_rows(stream.read())
    else:
        binary = args["--binary"] or os.environ.get("UAC_API_BINARY", "uac-api")
        revoked = query_ids(binary, args["--data"])
    write_snapshot(args["--out"], revoked, int(time.time()))
    print(json.dumps({"revocations": len(revoked), "out": args["--out"]}))


if __name__ == "__main__":
    main(sys.argv[1:])
