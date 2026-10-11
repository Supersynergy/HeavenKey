# HeavenKey 0.2 verification

The integrated Rust + TypeScript source passes the local full gate and portable CI script. Browser tests use virtual CTAP2 authenticators with real browser APIs and Rust verification. No physical authenticator was used.

| Check | Executed result |
| --- | --- |
| just check | Exit 0; 24 Rust-core tests, TypeScript, Clippy, build, dependency/source/license checks |
| just e2e | 41 passed, 0 failed; owner bootstrap, invocation, rejection cases, revocation and restart |
| bash scripts/ci.sh | Exit 0 on local macOS; same portable commands configured for CI |
| Semgrep security-audit | Four source files, 0 findings, 0 errors |
| Gitleaks staged snapshot | About 1 MB of staged text, 0 findings |
| Timeout regression | Guard exit 124, detached child no longer running |
| Missing server binary | Explicit failure in under a second, completed=false, no indefinite cleanup wait |
| Fresh GitHub clone | Empty clone-local target, locked install/fetch, build and 41/41 browser cases; about 19.7 seconds on this macOS host |
| GitHub content | README and hero Git blob hashes match the pushed source |

## Hosted CI boundary

The [first GitHub run](https://github.com/Supersynergy/HeavenKey/actions/runs/38183062109) failed before starting any workflow step. GitHub's annotation states: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” The annotation cannot distinguish those two account conditions.

This is an account gate, not executed Linux test evidence. No billing, payment method, spending limit or self-hosted runner was changed. Once the account gate is resolved, the configured workflow can be dispatched again. The local passing script does not prove the Ubuntu runner environment.

## Review and remaining gates

The current enrollment, permission and failure paths were inspected and the explicit denial matrix was executed. Automated scans and this source review are not an independent penetration test. Hardware, production provisioning, recovery, key rotation, tenant boundaries, distributed concurrency and interoperability remain open in ROADMAP.md.

The acceptance JSON contains integrated source hashes; the original spike acceptance is separately archived. The successful fresh-clone run tested source commit 29a9bacd55548722f62eeb84787eb4dbfde9ca41. Its full step list is in evidence/heavenkey-fresh-clone.json. The first failed clone run is retained with its build-path and startup-cleanup diagnosis.
