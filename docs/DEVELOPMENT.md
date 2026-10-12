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

The user explicitly authorized expert subagents. Three lanes own Rust authorization, browser UI/E2E and independent security review. Each receives a fresh scope-and-oracle capsule without parent history. The controller owns documentation, package pins, integration and acceptance. Writers have disjoint files and no commit authority; only one fixed-port E2E runs at a time. No acceleration multiplier or financial saving is inferred from parallel work.

For 0.4, Best Defaults selects server-enforced action approvals before wider delegation: the baseline demonstrates sensitive writes using only a copied valid session. The implementation reuses the existing WebAuthn handlers and typed action data. The shared contract is STEPUP-CONTRACT.md; the full gate and independent review run on the resulting integrated source. Existing dependencies remain pinned. A failed or canceled browser ceremony can be retried; it cannot authorize an unrelated operation. Remote source equality, a fresh clone and hosted CI status are separate evidence surfaces.

For 0.5, the closed objective is a passkey-approved online delegation chain and transitive revocation at the API execution point. DELEGATION-CONTRACT.md fixes the profile, signing bytes, limits, endpoints and disjoint expert ownership before implementation. Metacode found no fitting delegation donor; existing Ed25519/WebAuthn/SQLite dependencies are reused. The browser lane independently authors a Node standard-crypto encoder and public synthetic vectors; Rust consumes those fixtures and the browser checks actual API-produced signatures. The read-only reference CLI joins both native and portable CI gates. The custom service-attested profile is explicitly separate from UCAN, DIDs and holder-signed offline credentials.
