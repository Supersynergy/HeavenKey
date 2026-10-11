# HeavenKey roadmap

These are bounded development slices, not promises of universal compatibility.

| Phase | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| 0.1 | Passkey and grant simulation | 35 browser cases, 24 Rust tests | Completed; hardware deferred |
| 0.2 | Operator bootstrap and GitHub foundation | Guest-first and wrong-token denial, one owner under competing ceremonies, restart and source checks | Completed locally; hosted CI account gate open |
| 0.3 | Multiple credentials and device lifecycle | Add a second credential, use both, remove one without losing the last, persist revocation | Next |
| 0.4 | Delegation wire profile | Versioned profile, interoperable vectors, bounded chains, transitive revocation | Planned |
| Pilot | Tenants, audit, HTTPS, recovery | Tenant denial matrix, recovery rehearsal, rotation, external review | Planned |
| Hardware | Touch ID, phone, security key | Operator-confirmed enrollment, cancel/error and recovery tests | Deferred by user |
| Offline/device | Controlled device verifier | Explicit stale-revocation behavior, clock handling, reconnect and failure tests | Planned |

Remaining pilot work is provisionally **20–37 person-days**, about **4–8 weeks** for one developer. A hardened web product is provisionally **3–5 months**. Mobile clients, one controlled offline device and one wallet-chain adapter remain **6–12 months with 2–3 developers**, subject to integration access. These are planning ranges, not measured hours or guaranteed integration dates. The bootstrap slice removes one prototype shortcut; trusted provisioning and recovery still require further work.
