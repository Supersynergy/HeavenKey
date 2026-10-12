# Action-bound passkey approvals

Best Defaults prioritizes a concrete authority gap before wider delegation features. The v0.3 API accepts a valid bearer session for sensitive writes; fresh passkey confirmation is only requested by the UI. The baseline probe uses synthetic users and virtual CTAP2 devices and records the observed token-only mutations in evidence/stepup-baseline.json.

## Shared API contract

Reuse /api/auth/start and /api/auth/finish. Add optional management to both JSON bodies. Management and invocation are mutually exclusive. Ordinary login and resource invocation keep their current behavior; omitted management means null.

Management is a strict tagged object, with kind and exactly these fields:

- credential_add: label
- credential_revoke: id
- grant_create: guest_name, ttl_seconds
- grant_revoke: id

A management start and finish require the same valid Bearer session. Its account must match name. Owner-only actions check owner role. The server pairs its fresh WebAuthn challenge with the precise operation and parameters. The finish consumes the ceremony, compares the operation/session, verifies user verification and the current active signing key/counter, then issues {approval_id,approved:true,expires_in:60}. It creates no new login session and executes no mutation yet.

The four existing mutation bodies add approval_id. Missing approval is403 approval_required after the existing authentication/role/basic parameter checks. The approval must match exact operation/parameters, session and account and an active signing credential. It is single-use: a parsed consumption attempt removes it even when target/session/parameters mismatch. Store it only in process memory, capped at128; use std::time::Instant for its60-second lifetime. Restart discards it. Credential revocation clears all approvals and pending ceremonies/sessions of that account.

Credential-add approval is consumed at /api/credentials/start. The enrollment is then bound to that same session and the actual approving key; /finish still requires its purpose/session-bound enrollment state. Existing cap8, label1–48, globally unique credential IDs, tombstones, last-key protection, counter handling, initial owner bootstrap and account grant alias remain intact. Recheck limits at finish. Server clock infrastructure, recovery and delegation wire format are separate workstreams.

## Browser behavior

Use the installed SimpleWebAuthn browser adapter. Replace the current generic fresh-login step before credential writes with the management-specific assertion; pass approval_id immediately to the exact mutation. Grant issuance/revocation also use this path. Existing login and guest invocation remain separate. Show the concrete action/target before asking for confirmation. Keep cancellation/errors recoverable and serialize actions. Never store approval/session tokens in persistent browser storage or logs.

## Oracle and ownership

Rust lane owns apps/api/src/main.rs and its tests. Browser lane owns apps/web/src/main.ts, apps/web/index.html, apps/web/src/style.css and scripts/e2e.mjs. Review lane owns docs/evidence/stepup-independent-review.json and docs/STEPUP-REVIEW.md. The controller owns documentation, manifests, evidence integration and publication. Writers are not alone; preserve other edits. No subagent commits or pushes.

Oracle: just check and just e2e. Preserve the existing69 behavioral cases, adapting only legitimate mutations to include verified approval. Add token-only denial for all four actions; exact target/TTL/label/kind/session/user binding; replay/parallel duplicate denial; approval expiry (monotonic unit test); restart and revocation invalidation; and an actual aborted browser assertion followed by successful retry. Hardware stays virtual. Do not add dependencies, crypto primitives, a second backend, clock-test backdoors or a live authenticator flow. Bound each agent lane to45 minutes, each test/process with a timeout and a compact evidence return.
