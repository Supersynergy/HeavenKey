build:
    python3 scripts/run.py build 900 -- just _build

_build:
    bun run build
    cargo build --locked --offline

check:
    python3 scripts/run.py check 900 -- just _check

_check:
    HEAVENKEY_ADVISORIES_OFFLINE=1 bash scripts/ci.sh check

ci:
    bash scripts/ci.sh prepare
    python3 scripts/run.py ci 1200 -- bash scripts/ci.sh

github-ci:
    python3 scripts/github_ci.py

e2e:
    python3 scripts/run.py e2e 300 -- bun scripts/e2e.mjs

dev:
    bun run build
    python3 scripts/run.py manual-dev 7200 -- cargo run --locked --offline -p uac-api
