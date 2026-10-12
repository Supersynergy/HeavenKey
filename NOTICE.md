# Third-party notices

The original HeavenKey source is private; see LICENSE. Dependencies retain their own licenses. The versions and registry checksums in Cargo.lock and bun.lock identify the packages used by the project, while cargo-deny checks their declared licenses and sources against the local policy. This notice does not replace dependency licenses.

The MPL-2.0 license for webauthn-rs 0.5.5 is preserved in docs/evidence/webauthn-rs-LICENSE.txt; the API uses this upstream crate without vendored modifications. Upstream source: https://github.com/kanidm/webauthn-rs. Later distribution must satisfy the applicable dependency licenses.

The implementation reuses axum, tokio, rusqlite, ed25519-dalek, serde, sha2 and related crates. TypeScript and playwright-core are development dependencies.

The README hero was generated for this project. It is illustrative artwork, not hardware evidence. Browser screenshots use synthetic local fixtures. No external fonts, customer records or stock photographs are included. See docs/assets/README.md.

HeavenKey 0.3 uses @simplewebauthn/browser 14.0.0 as its browser ceremony adapter. The MIT license and Matthew Miller copyright notice are preserved in docs/licenses/simplewebauthn-browser-MIT.txt and included in every generated browser bundle. It introduces no transitive runtime dependency. The exact package SHA-512 is pinned in bun.lock; dependency decisions and source links are recorded in docs/DONORS.md.
