#!/usr/bin/env bash
set -euo pipefail

prepare() {
  mkdir -p docs/evidence
  rm -f docs/evidence/ci.log docs/evidence/ci-*.log docs/evidence/commands.jsonl \
    docs/evidence/e2e.json docs/evidence/heavenkey-missing-binary.json \
    docs/evidence/browser-*.png docs/evidence/failure-*.png \
    docs/evidence/failure-diagnostic.json
  rm -f apps/extension/TEST-RECEIPT.json apps/extension/INTEGRATION-BLOCKER.json
  rm -f docs/evidence/password-access/browser.json
}

source_checks() {
  python3 -m unittest discover -s scripts -p 'test_*.py'
  bun run build
  cargo fmt --check
  bun run node_modules/typescript/bin/tsc --noEmit
  bun test apps/web/src/vault.test.ts
  bun test apps/web/src/passwords-crypto.test.ts
  bun test apps/web/src/passwords-privacy.test.ts
  bun test apps/web/src/passwords-profiles.test.ts packages/forms/import-plan.test.ts
  bun test apps/web/src/passwords-access.test.ts apps/web/src/passwords-sharing.test.ts
  bun test apps/web/src/interface.test.ts
  bun test apps/extension/popup.test.ts
  bun scripts/test_extension.mjs
  bun scripts/delegation-reference.mjs
  bun scripts/grant-reference.mjs
  cargo clippy --locked --offline --all-targets -- -D warnings
  cargo test --locked --offline
  python3 scripts/startup_probe.py
}

security_checks() {
  if [[ ${HEAVENKEY_ADVISORIES_OFFLINE:-0} == 1 ]]; then
    cargo deny --locked --offline check
    cargo audit --no-fetch --no-yanked
  else
    cargo deny --locked check
    cargo audit --no-yanked
  fi
  bun audit
}

build() {
  bun run build
  cargo build --locked --offline
  HEAVENKEY_INTEGRATION_BINARY=target/debug/uac-api python3 -m unittest scripts.test_workstream_integration
  HEAVENKEY_INTEGRATION_BINARY=target/debug/uac-api python3 -m unittest scripts.test_password_manager
  HEAVENKEY_INTEGRATION_BINARY=target/debug/uac-api python3 -m unittest scripts.test_extension_pairing
  HEAVENKEY_PM_DESIGN=1 HEAVENKEY_PM_POLISH=1 HEAVENKEY_PM_WORKFLOWS=1 bun scripts/password_manager_e2e.mjs
  bun scripts/password_access_e2e.ts
  bun scripts/extension_autofill_e2e.ts
  bun scripts/password_manager_ui_test.ts
  bun scripts/protocol_e2e.mjs
}

case ${1:-all} in
  prepare) prepare ;;
  source) source_checks ;;
  security) security_checks ;;
  build) build ;;
  e2e) python3 scripts/run.py ci-e2e 300 -- bun scripts/e2e.mjs ;;
  check) source_checks; security_checks; build ;;
  all) source_checks; security_checks; build
    python3 scripts/run.py ci-e2e 300 -- bun scripts/e2e.mjs ;;
  *) printf 'Unknown CI stage: %s\n' "$1" >&2; exit 2 ;;
esac
