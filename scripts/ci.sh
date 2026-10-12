#!/usr/bin/env bash
set -euo pipefail
cargo fmt --check
bun run node_modules/typescript/bin/tsc --noEmit
bun scripts/delegation-reference.mjs
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
bun audit
python3 scripts/startup_probe.py
bun run build
cargo build --locked --offline
python3 scripts/run.py ci-e2e 180 -- bun scripts/e2e.mjs
