# Development contract

The main cost is security rework. Integration access is still uncertain. The loop is objective, executable acceptance, bottleneck, smallest complete slice, verification and recorded evidence. A token-saving claim requires a comparison that includes the failures and checking needed to produce the same accepted result.

Metacode was used during preflight to check reusable sources. No donor implementation was copied. The Efficiency Orchestrator bounds work, sequences dependent changes and ties claims to output. They are optional development aids and are not application dependencies.

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
