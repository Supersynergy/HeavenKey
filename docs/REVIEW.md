# Current-state review

Scope: apps/api/src/main.rs, crates/verifier/src/lib.rs, apps/web/src/main.ts and scripts/e2e.mjs. This is a source review plus automated scans, not an independent penetration test or production certification.

Trust and failure paths reviewed:

- The issuer key is generated with OS-seeded RNG, never sent to the browser, persisted privately and reused after restart.
- Owner bootstrap requires a random operator-only local token and verified WebAuthn enrollment. A guest-first ceremony stays a guest. A database unique index limits owners; start and finish recheck consumption. The authority stays consumed on restart. Legacy first-enrollment data remains a separate migration boundary.
- WebAuthn registration/authentication state stays server-side. Every finish consumes the state before verifying; restart invalidates pending state.
- Credential IDs are unique across users. Authentication checks library validation, user verification and the current persisted counter.
- A grant's audience derives from the registered credential ID; the assertion must match that user's stored public key. The Rust grant verifier checks its trusted issuer, scope, audience, signature, expiry and revocation.
- A random WebAuthn challenge is tied server-side to the exact invocation. Finish compares the stored invocation before execution; a request cannot switch action, arguments or become a login.
- Revocation is checked again after authentication and inside the operation transaction. The committed operation ID is unique. Expired/revoked grants and replays after restart are rejected.
- Mutating endpoints check Origin; all requests check Host. SQLite statements use bound parameters. No CORS is enabled. Bodies and concurrent pending ceremonies are bounded.
- The UI uses textContent, retains session tokens only in memory and labels simulation/hardware limits. It disables revoked or expired guest actions.
- Test private keys come only from virtual authenticators, are used locally to sign negative fixtures and are not recorded in reports.

Executed evidence is in e2e.json and the native check log. Semgrep's security-audit rules scanned four source files without findings or parser errors. Gitleaks scoped to apps/, crates/ and scripts/ found zero secrets. The earlier default scan included dependencies/build artifacts; its metadata is separately diagnosed rather than treated as a successful source scan.

Remaining release gates: real-device UX, production owner identity/provisioning, multiple devices and recovery, key rotation, tenant model, distributed concurrency, rate limits, hardened storage/permissions, secure time for offline operation, formal wire-profile choice, second independent verifier and external review. No production release is claimed.
