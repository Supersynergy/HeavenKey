build:
    python3 scripts/run.py build 900 -- just _build

_build:
    bun run build
    cargo build --locked --offline

check:
    python3 scripts/run.py check 900 -- just _check

_check:
    cargo fmt --check
    bun run node_modules/typescript/bin/tsc --noEmit
    bun scripts/delegation-reference.mjs
    cargo clippy --locked --offline --all-targets -- -D warnings
    cargo nextest run --locked --offline
    cargo deny --offline check
    cargo audit --no-fetch --no-yanked
    bun audit
    python3 scripts/startup_probe.py
    bun run build
    cargo build --locked --offline

e2e:
    python3 scripts/run.py e2e 180 -- bun scripts/e2e.mjs

dev:
    bun run build
    python3 scripts/run.py manual-dev 7200 -- cargo run --locked --offline -p uac-api
