# Development contract

The main cost is security rework. Integration access is still uncertain. The loop is objective, executable acceptance, bottleneck, smallest complete slice, verification and recorded evidence. A token-saving claim requires a comparison that includes the failures and checking needed to produce the same accepted result.

Metacode was used during preflight and v0.3 to find reusable sources, followed by primary-source checks. HeavenKey consumes webauthn-rs and the MIT SimpleWebAuthn browser package. No product implementation was copied from Enpass or the reference tools. The Efficiency Orchestrator bounds work and ties claims to output. Skills are development aids; the selected libraries are pinned application dependencies. See DONORS.md for the distinction.

| Selected SI Atlas skill | Contribution |
| --- | --- |
| metacode | Reuse and provenance |
| agent-efficiency-orchestrator | Bounded execution and evidence |
| best-defaults | Result, effort and risk prioritization |
| ponytail | Small complete changes and dependency reuse |
| speedtuning | Dominant cost and equivalent-workload measurement |
| security-review | Trust boundaries and denial paths |
| rust-patterns | Ownership and error handling |
| rust-testing | Core invariants and failure cases |
| coding-standards | Structure and maintainability |
| verification-loop | Current integrated-state checks |

The initial skill-path/hash inventory remains in evidence/skills.json. It records the development environment, not portable runtime dependencies. The README phase additionally uses Repo Release Excellence; the workbench retains its Hallmark design contract.

Run `just check` for the full local gate and `just e2e` for browser acceptance. Portable CI uses `bash scripts/ci.sh` after fetching locked dependencies. Commands have timeouts; HEAVENKEY_DEADLINE_UTC can impose a shared cutoff. The original eight-hour spike budget remains historical evidence.

CI uses read-only permission, pinned action commit SHAs and a 20-minute job limit. It runs on push, pull_request and manual dispatch, with no deployment or real authenticator. The design follows [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

The user explicitly authorized v0.3 expert subagents. Three lanes own Rust credential lifecycle, browser UI/E2E and donor research/security review. The controller owns image, documentation, package pins, integration and acceptance. Writers have disjoint files and no commit authority; only one fixed-port E2E runs at a time. No acceleration multiplier or financial saving is inferred from parallel work.
