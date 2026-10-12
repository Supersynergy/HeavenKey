# HeavenKey roadmap

These are bounded development slices, not promises of universal compatibility.

| Phase | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| 0.1 | Passkey and grant simulation | 35 browser cases, 24 Rust tests | Completed; hardware deferred |
| 0.2 | Operator bootstrap and GitHub foundation | Guest-first and wrong-token denial, one owner under competing ceremonies, restart and source checks | Completed locally; hosted CI account gate open |
| 0.3 | Multiple credentials and device lifecycle | Add/use keys, revoke with last-key protection, persist state, migrate legacy data | Integrated simulation; gates in V03-RESULT.md |
| 0.4 | Action-bound passkey approvals | Four bearer-only write denials, exact operation/session binding, single use, expiry, cancellation/retry, revocation and restart | Completed simulation:96 browser cases,36 Rust tests,independent review,fresh GitHub clone; hosted CI account gate open |
| 0.5 | Service-attested delegation v1 | Versioned bytes,independent Rust/Node vectors,5-link chains,attenuation,transitive revocation at browser/API access | Completed simulation:138 browser cases,45 Rust tests,75 reference checks,independent review,fresh GitHub clone;hosted CI account gate open |
| Protocol interoperability | UCAN/DID or selected external wire profile | Independent external implementation,vectors and key/identity model agreement | Planned;0.5 makes no UCAN/DID claim |
| Pilot | Tenants, audit, HTTPS, recovery | Tenant denial matrix, recovery rehearsal, rotation, external review | Planned |
| Hardware | Touch ID, phone, security key | Operator-confirmed enrollment, cancel/error and recovery tests | Deferred by user |
| Offline/device | Controlled device verifier | Explicit stale-revocation behavior, clock handling, reconnect and failure tests | Planned |

Remaining pilot work is provisionally **20–37 person-days**, about **4–8 weeks** for one developer. A hardened web product is provisionally **3–5 months**. Mobile clients, one controlled offline device and one wallet-chain adapter remain **6–12 months with 2–3 developers**, subject to integration access. These are planning ranges, not measured hours or guaranteed integration dates. The action-approval slice closes a reproduced authority gap; trusted provisioning, recovery, encrypted state and target-specific integration still require further work. The estimate is not reduced merely because agents work in parallel.
