# Contributing

Every change must specify the behavior that a caller should observe and the test that will fail when this contract is broken. Keep product code in apps/, shared Rust in crates/ and checks in scripts/. Reuse reviewed crypto and WebAuthn libraries. Preserve denial paths, accessibility and error handling.

Install the tools in README.md, run `just check` and `just e2e`, then inspect the affected tests and current source. Use synthetic data only. Never commit issuer keys, bootstrap codes, sessions, real credentials, local databases or .env files.

Metacode helps find reusable patterns; the Efficiency Orchestrator bounds work and ties claims to evidence. They are development aids, not runtime dependencies or substitutes for review.

Change one measurable slice at a time. Hardware tests need a scheduled live operator session. Virtual authenticators do not close that gate. Grant-format changes need a versioned compatibility decision and cross-verifier evidence.
