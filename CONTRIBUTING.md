# Contributing

Every change must specify the behavior that a caller should observe and the test that will fail when this contract is broken. Keep product code in apps/, shared Rust in crates/ and checks in scripts/. Reuse reviewed crypto and WebAuthn libraries. Preserve denial paths, accessibility and error handling.

Install the tools in docs/DEVELOPMENT.md, run `just check` and `just e2e`, then inspect the affected tests and current source. Use synthetic data only. Never commit issuer keys, bootstrap codes, sessions, real credentials, local databases or .env files.

Change one measurable slice at a time. Hardware tests need a scheduled live operator session. Virtual authenticators do not close that gate. Grant-format changes need a versioned compatibility decision and cross-verifier evidence.

## Rights for new contributions

Before a new external contribution is accepted, its rights holder and the repository owner must explicitly agree in writing on the rights needed for proprietary use and distribution. Merely opening a pull request does not transfer copyright or establish an unrestricted assignment. Do not submit third-party code without identifying its license and provenance. Existing grants and third-party rights are preserved; see LICENSE and docs/LICENSING.md.
