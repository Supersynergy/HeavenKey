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

portable target:
    python3 scripts/build_portable.py {{target}}

package *targets:
    python3 scripts/package_release.py {{targets}}

mobile-check:
    python3 scripts/run.py mobile-check 180 -- just _mobile-check

_mobile-check:
    cd apps/mobile && dart format --output=none --set-exit-if-changed lib test integration_test
    cd apps/mobile && flutter analyze --no-pub
    cd apps/mobile && flutter test --no-pub
    python3 scripts/mobile_native_gate.py all

mobile-android:
    python3 scripts/run.py mobile-android 300 -- just _mobile-android

_mobile-android:
    cd apps/mobile && flutter build apk --debug --no-pub

mobile-backup-check:
    python3 scripts/run.py mobile-backup-check 240 -- just _mobile-backup-check

_mobile-backup-check:
    bun scripts/mobile_backup_reference.mjs
    just _mobile-check
    python3 scripts/mobile_backup_acceptance.py

mobile-origin-check:
    python3 scripts/mobile_origin_check.py

mobile-adaptive-check:
    python3 scripts/run.py mobile-adaptive-check 300 -- just _mobile-adaptive-check

_mobile-adaptive-check:
    just _mobile-backup-check
    python3 scripts/mobile_origin_check.py

mobile-connected-check:
    python3 scripts/run.py mobile-connected-check 300 -- just _mobile-connected-check

_mobile-connected-check:
    just _mobile-adaptive-check
    bun test apps/web/src/passwords-sync.test.ts
    python3 scripts/mobile_passkey_policy_check.py --evidence /tmp/heavenkey-mobile-policy-check.log
    python3 scripts/mobile_connected_acceptance.py

release-check:
    python3 scripts/release_acceptance.py --live

identity-check:
    npm test --prefix apps/identity-pilot
    npm audit --prefix apps/identity-pilot
    python3 -m py_compile scripts/identity_pilot.py

identity-pilot:
    python3 scripts/identity_pilot.py

identity-e2e:
    python3 scripts/identity_pilot.py --e2e --seconds 300
