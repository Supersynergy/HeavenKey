# CI repair after HeavenKey 0.5

The GitHub-hosted job was rejected before runner allocation. The fresh dispatch on source `d02a93c` confirms the same account condition as the earlier 0.5 runs: failed account payments or a spending-limit condition. GitHub's annotation does not distinguish the two. Actions are enabled and the four pinned action commits resolve to their official repositories.

This account condition needs attention in [GitHub Billing](https://github.com/settings/billing). [GitHub's billing troubleshooting guidance](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#reviewing-billing-errors) explains the payment and budget checks. This repair does not alter account payments, spending limits, repository visibility or runner registration.

The workflow also had two defects independent of the account condition:

- An early dependency or source-check failure could upload previously committed green browser reports. The workflow now removes only runtime CI reports and screenshots immediately after checkout. Historical acceptance evidence stays in the checkout. Failure diagnostics and screenshots are included in uploads.
- CI omitted the Rust advisory, license and dependency-source gates from the local check. It now runs `cargo deny --locked check` and `cargo audit --no-yanked`. Online mode initializes their advisory databases on a fresh runner.

CI uses the same security-tool versions as the local gates: cargo-deny 0.20.2 and cargo-audit 0.22.2. Official x86_64 Linux-musl archives are fixed by URL and SHA256; the hash is checked before extraction or execution. Both archives were fetched independently and their member paths verified. Prebuilt tools avoid compiling these development tools during every job; setup-time savings have not been measured.

| Verification | Result |
| --- | --- |
| Workflow and shell syntax | `actionlint` and `bash -n`: exit 0 |
| Early-failure regression | Six stale runtime files removed; historical acceptance preserved; a simulated early failure cannot expose a stale green E2E report |
| Local corrected CI script | Exit 0 on macOS; 45 Rust tests and 138 browser cases passed, including the real Rust passkey verifier |
| Public local check | `just check`: exit 0, including nextest, license/source/advisory checks and build |
| Independent workflow audit | Official action commits, Linux tool archive hashes/paths and toolchain availability checked; report: `evidence/ci-repair-audit.json` |
| Hosted Ubuntu execution | Still requires removal of the account block; local success is not hosted proof |
| Hardware passkeys | Deferred by the user |

The local verifier used a temporary source checkout, a frozen Bun install and a warm shared Rust target. Its first verification attempt missed workspace dependencies because it linked only root node_modules; the verification program was corrected to install from the lockfile. Source was unchanged, and the failed attempt is retained in the controller's external reports. Local elapsed times are cache-dependent and do not estimate a cold Ubuntu job.

`evidence/ci-repair-local.json` records the tested workflow/script hashes and local results. `evidence/ci-repair-github.json` records the fresh pre-repair account rejection. The corrected workflow keeps the existing single `verify` job and all existing browser cases; no checks are skipped to obtain a green badge.
