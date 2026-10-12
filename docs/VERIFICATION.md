# HeavenKey 0.5 verification

The controller executed the public native gates on the integrated 0.5 manifests and source. WebAuthn tests use isolated virtual CTAP2 authenticators in Chrome and the real Rust verifier; no physical device was used.

| Check | Executed result |
| --- | --- |
| `just check` | Exit 0, ATS green; 45/45 Rust tests, TypeScript, fmt, Clippy, nextest, source/license/advisory checks, negative startup regression and build |
| Independent reference |75 checks with Bun inside `just check`; separate Node execution also75 passed |
| `just e2e` |138/138; 96 original cases retained, 42 added, 0 removed |
| Delegation path |Three- and five-link actual API/passkey chains, attenuation, current ancestor revocation, pending invocation, new-child approval and restart |
| Independent review |19 checks, 24 source/bundle/manifest hashes and8 evidence hashes compared, 0 blockers |
| Semgrep |10 own source files, 0 findings, 0 errors |
| Grepgod review/security |Bounded exit0; source diff/security tools inspected; native scanner reports remain authoritative |
| Aislop |Exit 0, 0 errors, 6 style warnings; no warning-only source refactor |

The full check output is evidence/v05-check-full.log; compact ATS results are v05-check.log and v05-e2e.log. E2E case evidence is e2e.json. The controller and independent reviewer compared names against 5de017d:96 retained, 42 added, 0 removed. The actual issuer service signs every profile link; account aliases do not become holder signing keys.

The six style warnings concern API/E2E file length, one regex escape, an existing bounded startup polling catch and two intentional negative-vector catches. Invalid reference fixtures retain null preimages or allowed=false and are checked against committed expectations. No confirmed defect was found; the scan score is not a security assurance.

## Parser and interoperability boundary

Rust is the authoritative strict raw parser. The independent reference verifies the committed 32grant fixtures, 35 chain cases and7 raw JSON denials, plus actual API signatures and identifiers. This is evidence for the HeavenKey profile and specific tested inputs. General JSON number-grammar equality, all Ed25519 policy edge cases and compatibility with external UCAN/DID implementations remain unproved. Service signing requires the current online account authorization; offline parties need updated revocation information.

## Publication gates

Secret scans, fresh locked GitHub clone and exact remote bytes are recorded during final publication. Until that evidence is present, local source/test success alone is not a fresh-clone or GitHub claim. The previous hosted CI run was account-gated before any step; the 0.5 push run is checked separately. No billing, limits or runner changes are part of this task.

Hardware, biometrics, provider sync, recovery, tenants, encryption, rotation, distributed execution and offline clock resilience remain separate gates. Historical reports and acceptance-v04.json preserve the prior phase.

Any later change to the reviewed Rust or browser source invalidates its affected oracle evidence and requires a new check before publication; documentation-only updates do not alter the executed application.
