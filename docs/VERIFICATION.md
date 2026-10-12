# HeavenKey 0.4 verification

The integrated Rust and TypeScript source passes the complete local check recipe and the browser oracle. Tests use virtual CTAP2 authenticators with native browser WebAuthn APIs and the real Rust verifier. No physical device or biometric was used.

| Check | Executed result |
| --- | --- |
| Full local recipe | `scripts/run.py stepup-check 900 -- ats-verify --json -- just _check`: exit0, ATS green; the recipe behind `just check` |
| Rust tests | 36/36:24 verifier tests and12 API tests |
| Browser oracle | `just e2e`:96/96, including all69 prior cases and27 added approval cases |
| Valid session without approval | All four sensitive writes denied with403 |
| Native browser cancellation | In-progress assertion aborted through the SDK, then retried successfully without a new login |
| Approval expiry | Monotonic Instant expiry unit test; no elapsed60s hardware or browser test |
| Source and dependency checks | TypeScript, fmt, Clippy, cargo-deny/audit, Bun audit, build and missing-binary regression green |
| Aislop changed-source scan | Exit0;0 errors,3 nonblocking style warnings,0 AI-slop indicators |
| Independent source review | 17 checks,14 source/manifest/bundle hashes compared,0 blocking findings |
| Semgrep security audit | 8 own source files,0 findings,0 errors |
| Staged secret scan | Exit0,0 findings; historical exceptions remain limited to2 exact image-checksum fingerprints |
| Git-history secret scan | Exit0,0 findings with the same2 exact historical exceptions |
| Fresh GitHub clone | Source `db31bae`;22 integrated hashes match,empty clone-local target,locked install/build,96/96 browser cases;clone removed |

The complete check log is evidence/stepup-check-full.log; the compact ATS result is evidence/stepup-check.log. Browser case names and execution results are in evidence/e2e.json. The controller compared case names against source41f05eb:69 preserved,0 removed. The original red baseline and the separate independent source review remain explicit artifacts.

Source scans, independent final hash review and fresh-clone verification are recorded in the acceptance JSON. The clone run took about355s under high host load,including258s build and66s browser execution,with a warm package-registry cache. It is not an equivalent-workload speed comparison. Final GitHub source equality is checked separately after the documentation/evidence commit; application source remains identical to the reviewed and clone-tested version.

## Hosted CI boundary

The [0.4 GitHub run](https://github.com/Supersynergy/HeavenKey/actions/runs/38186956142) for source commit `db31bae` failed before starting any workflow step. GitHub reports a failed-payment or spending-limit condition; its annotation does not distinguish those two causes. The run has zero executed steps. The raw annotation is preserved in evidence/stepup-github-ci-annotations.json.

This is an account gate, not executed Linux test evidence. Billing, payments, limits and runners remain under the operator's control. Passing checks on macOS do not prove the Ubuntu environment.

## Remaining proof boundaries

Action approvals are enforced at the API access point and bind the exact data to a server-side WebAuthn challenge. They do not provide trusted transaction text on the authenticator or protection from a compromised browser displaying different data.

Source review and automated scans do not replace an external penetration test. Real devices, recovery, encrypted state, tenants, rotation, distributed concurrency and protocol interoperability remain separate roadmap gates. Versions0.1–0.3 retain their historical reports and evidence; acceptance-v03.json preserves the previous acceptance snapshot.
