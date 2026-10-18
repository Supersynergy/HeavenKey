# SmartField source provenance

HeavenKey ports reviewed local form primitives and text extraction from SmartField, authored as `smartfield local` in its manifest. The original source remains read-only at `/Users/master/BASE/projects/smartfield`. Integration was explicitly authorized by the repository operator. No separate donor license file was present in the inspected donor root; this notice does not invent a third-party license grant.

Original inspected sources (SHA-256):

- `extension/extract.js`: `3a805267b059623908a86cb1138a5bf85f84aa5cabd3c52fbb231e07658d6213`
- `extension/fill.js`: `a6d45ff38b323f50d7e0e541c8031fa779f65f2d02641ad902fb26cff1217eea`

`vendor/extract.js` contains deterministic de/en entity extraction, format validators, IBAN mod-97 and card Luhn checks. `vendor/fill.js` ports field recognition, autocomplete mapping, country/salutation aliases, split dates/phone/card values, open-shadow traversal, coercion and native setters. HeavenKey's `content.ts` supplies the restricted scanner, explicit field selection, origin/navigation binding, sensitivity gates, capture and bounded undo. Unrestricted donor fill/harvest entry points are not used. No donor key files, profile storage, session keys, external messaging or native host code were copied.

The vault KDF includes @noble/hashes 2.4.0 (MIT). See noble-hashes-MIT.txt. Its Argon2 implementation is outside the historical independent Cure53 audit; see the release verification notes.
