# HeavenKey

Scope: local Rust + TypeScript access lab, published in the Supersynergy GitHub account. No production deployment, real wallet, vehicle, or user credential import. The original spike had an eight-hour budget; new commands have explicit foreground timeouts and may use HEAVENKEY_DEADLINE_UTC for a phase cutoff. Respect other edits. Publishing this repository is authorized; hardware testing remains deferred.

Oracle: `just check` and `just e2e`; browser tests use isolated virtual CTAP2 authenticators and the real Rust WebAuthn verifier. Label hardware verification as deferred.

Structure: deployables in apps/, shared Rust in crates/, helpers in scripts/, evidence in docs/evidence/. Reuse reviewed crypto and WebAuthn libraries. No custom signing primitives. No secrets in logs.

Owner provisioning requires the operator's local single-use bootstrap token and verified passkey enrollment. Never restore first-visitor ownership. Use synthetic data in tests; never commit data/, local tokens, issuer keys or user credentials. The grant wire format remains experimental and is not UCAN interoperability.
