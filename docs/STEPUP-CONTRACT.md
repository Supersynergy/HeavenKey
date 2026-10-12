# Action-bound passkey approvals

Sensitive credential and grant writes require a fresh passkey approval bound to the precise action. This contract covers the four credential/grant mutations; version 0.5 extends management approvals for [delegation mutations](DELEGATION-CONTRACT.md).

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

The browser uses the SimpleWebAuthn adapter and a management-specific assertion before credential writes. It passes approval_id immediately to the exact mutation. Grant issuance/revocation also use this path. Existing login and guest invocation remain separate. Show the concrete action/target before asking for confirmation. Keep cancellation/errors recoverable and serialize actions. Never store approval/session tokens in persistent browser storage or logs.

## Verification

Run `just check` and `just e2e`. Cover missing approval, exact target/TTL/label/kind/session/account binding, replay and parallel duplicates, monotonic expiry, restart, revocation, and an aborted passkey assertion followed by a successful retry. Browser checks use virtual authenticators; hardware remains a separate test.
