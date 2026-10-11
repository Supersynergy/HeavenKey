# Third-party notices

The original HeavenKey source is private; see LICENSE. Dependencies retain their own licenses. Versions, registry checksums and sources are recorded in Cargo.lock and bun.lock. Local license/source checks use cargo-deny; this notice does not replace dependency licenses.

The API uses webauthn-rs 0.5.5 under MPL-2.0. Its license is preserved in docs/evidence/webauthn-rs-LICENSE.txt. Upstream source: https://github.com/kanidm/webauthn-rs. No vendored modification is included. Later distribution must satisfy the applicable dependency licenses.

The implementation reuses axum, tokio, rusqlite, ed25519-dalek, serde, sha2 and related crates. TypeScript and playwright-core are development dependencies. No third-party implementation was copied from Metacode donor repositories.

The README hero was generated for this project. It is illustrative artwork, not hardware evidence. Browser screenshots use synthetic local fixtures. No external fonts, customer records or stock photographs are included. See docs/assets/README.md.

HeavenKey 0.3 uses @simplewebauthn/browser 14.0.0 as its browser ceremony adapter. The MIT license and Matthew Miller copyright notice are preserved in docs/licenses/simplewebauthn-browser-MIT.txt and included in every generated browser bundle. It introduces no transitive runtime dependency. The exact package SHA-512 is pinned in bun.lock; donor decisions and source links are recorded in docs/DONORS.md.
