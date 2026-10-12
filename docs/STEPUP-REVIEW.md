# Independent review: action-bound passkey approvals

The reviewed action-approval implementation has no recorded blocking source findings. Local checks for version 0.4 passed 36 Rust tests and 96 virtual browser cases. [Review evidence](evidence/stepup-independent-review.json) records the detailed checks.

## Why this work comes first

The [baseline probe](evidence/stepup-baseline.json) records three sensitive changes succeeding with a copied valid session and no fresh assertion: grant creation, additional credential enrollment completion and original-credential revocation. Each returned HTTP 200 where the new contract requires denial. The grant-revocation gap is part of the contract's four-action gate, but is not a fourth observed success in that baseline JSON.

Recent reauthentication before passkey changes is explicit OWASP guidance. Account-to-credential mappings and server-side revocation must also remain controlled. [OWASP Passkey Security](https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html#credential-management).

OWASP separates ordinary authentication from transaction authorization. Authorization should be enforced by the server, protect the operation data, be unique and short-lived, and be checked again at execution. The implemented approval must therefore bind one operation and its parameters; a recent generic login alone is insufficient for this contract. [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html).

Prioritizing this reproduced authority gap before wider delegation is a project decision consistent with those controls. It reuses the installed verifier and browser adapter, with no new dependency or service. The sources support the required controls; they do not rank HeavenKey's roadmap or endorse a named Best Defaults method. Effort and acceleration multipliers have not been measured.

## What the review checks

Management assertions must use the same valid session and account at start and finish. The server compares the exact tagged operation, requires the current owner role for grant changes, verifies user verification through the existing WebAuthn verifier and reloads the active signing credential and counter. Login, resource invocation and management purposes remain separate. A successful management assertion issues an approval and neither logs the user in nor executes the requested mutation.

At mutation, the approval must match the account, exact session, operation, parameters and active signing key. A parsed consumption attempt spends it, including a mismatch. Its lifetime is 60 seconds measured with `Instant`; process restart discards it. The memory cap is 128. Credential-add consumes approval before its separate enrollment ceremony, which remains tied to the session and actual approving key. Revocation invalidates all account approvals, pending ceremonies and sessions. Last-key protection, capacity checks, tombstones and the stable account grant alias remain intact.

WebAuthn assertion verification checks the challenge, expected origin, RP binding, required verification and signature. The application supplies the business-operation binding by retaining the exact operation with the random server challenge. This is an application-specific approval protocol. It does not make a passkey a general transaction signer or prove that hardware displays the business parameters. [W3C WebAuthn Level 3, assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion).

The UI must display the action and target before requesting the assertion, use the stored session account, capture parameters once, serialize actions and handle cancellation without mutation. Approval/session tokens stay in memory and do not enter logs or persistent browser storage. Existing host/origin guards, parameterized SQL, safe text rendering and package pins remain part of the reviewed access path.

## Proof boundary

The current oracle covers token-only denial for all four changes, parameter/purpose/session/account mismatch, single-use and parallel replay, monotonic expiry, restart/revocation invalidation and an aborted browser assertion followed by a successful retry. The abort case starts a real `navigator.credentials` assertion against a virtual authenticator, cancels it through the browser adapter, confirms no finish/write request and then retries successfully. The original 69 behaviors remain covered.

The static scan reports 0 errors and 3 style warnings: two large files and an existing empty catch inside bounded startup health polling. These are not confirmed defects and do not require a warning-only refactor. Virtual CTAP2 tests verify browser/Rust behavior; real hardware, biometrics, provider sync, recovery and production deployment are outside this local review. Existing wall-clock session/ceremony infrastructure is a separate workstream. Relevant later source changes invalidate the affected review and test evidence.
