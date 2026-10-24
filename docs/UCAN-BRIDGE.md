# UCAN-Bridge: exportierte Kompatibilitäts-Sicht

`crates/ucan-bridge` bildet eine per `uac-verifier` geprüfte delegation-v1-Kette auf ein UCAN-1.0-artiges EdDSA-JWT ab. Dies ist eine exportierte Sicht für externe Prüfer: Das Delegationsformat bleibt das Primärformat, die Online-Prüfung des Dienstes bleibt maßgeblich. Es ist kein vollständiger UCAN-Stack — keine UCAN-Auflösung von Proof-Inhalten, kein UCAN-Invokationsformat und kein Revocation-Field; die Semantik des Widerrufs liegt weiterhin ausschließlich beim Dienst.

## Erzeugung

`export_token(chain, context, service_key)` führt zuerst die vollständige `delegation::verify_chain`-Prüfung durch (Wurzel-Signatur, Kettenstruktur, Zeitfenster, Widerrufsmenge, Halter, Ressource und Aktion). Nur eine im `context` aktuell gültige Kette erzeugt ein Token. `service_key` muss die vertrauenswürdige Wurzel sein, sonst schlägt der Export mit `UntrustedRoot` fehl — das Token ist damit immer gegen denselben Dienstschlüssel signierbar, der auch die Kettenglieder signiert hat.

## Token-Aufbau

Kompaktes JWS mit drei durch Punkt getrennten base64url-Segmenten (ohne Padding):

- Header: `{"alg":"EdDSA","typ":"JWT","ucv":"1.0.0"}` — feste Feldreihenfolge.
- Payload mit exakt den Feldern `att`, `aud`, `exp`, `iss`, `nbf`, `prf` in dieser (alphabetischen) Reihenfolge:
  - `att`: ein Eintrag `{"can": "read"|"write"|"unlock", "with": <resource>}` je Aktion des Blatt-Grants, sortiert nach der Enum-Reihenfolge Read, Write, Unlock.
  - `aud`: `did:key`-Hülle des 32-Byte-Alias des Blatt-Audience. Das ist ein stabiler Konto-Alias im gleichen Multicodec-Envelope, kein lebender Signierschlüssel.
  - `exp`/`nbf`: `expires_at` und `not_before` des Blatt-Grants.
  - `iss`: `did:key` des Ed25519-Dienst-Schlüssels — der einzige lebende Schlüssel im Token; die Token-Signatur verifiziert gegen ihn.
  - `prf`: IDs aller Vorfahren-Glieder (Wurzel zuerst) als CIDv0-förmige Multihash-Strings. Die Kette hat höchstens fünf Glieder, also höchstens vier Proofs.
- Signatur: Ed25519 über den ASCII-Bytes `header_b64 + "." + payload_b64` mit dem Dienst-Schlüssel.

Kodierungen: `did:key` ist `did:key:z` plus base58btc von `0xed 0x01 || 32 Bytes`. Ein Proof ist base58btc von `0x12 0x20 || delegation::id(link)` und damit ein Bezeichner, keine auflösbare Inhaltsadresse.

## Determinismus

Gleiche Kette, gleicher Kontext und gleicher Schlüssel ergeben bytegleiche Tokens. Die JSON-Felder serialisieren in fester Reihenfolge, Ed25519-Signaturen sind deterministisch (RFC 8032) und außer den Grant-Inhalten fließen weder Zufall noch Zeit ein.

## Unabhängige Referenz-Verifizierung

`scripts/ucan-reference.mjs` prüft Tokens mit der zweiten Implementierung (nur Node-/Bun-Standardkrypto, eigener JWS- und base58btc-Kodierer):

- `bun scripts/ucan-reference.mjs` (oder `node`) verifiziert `docs/vectors/ucan-bridge-v1.json` und meldet kompaktes JSON mit Prüfzahlen.
- `--generate` baut die Vektoren neu; die Rust-Tests in `crates/ucan-bridge` erzeugen dieselben Token-Bytes aus denselben Ketten.

Die Referenz prüft Segmentstruktur, Header-Felder und -Werte, Payload-Feldersatz, `did:key`- und Proof-Formate, die Signatur gegen den in `iss` eingebetteten Schlüssel sowie das Zeitfenster. Optionale Erwartungen binden den Token an Issuer-Pinning, Audience-Alias und angefragte `resource`/`action` — ohne Issuer-Pinning begründet eine gültige Signatur noch kein Vertrauen.

## Grenzen und TODOs

- `prf`-Einträge sind Bezeichner der Quellglieder; die Referenz löst sie nicht inhaltlich auf und prüft keine Proof-Kette.
- `aud`-Aliase sind keine Signierschlüssel; ein Token beweist nur die Dienst-Aussage, keine Halter-Signatur.
- Der Export bildet nur das Blatt ab: Delegator-Liste und Budget verbleiben im Primärformat.
- TODO: `scripts/ucan-reference.mjs` neben `delegation-reference.mjs` in `scripts/ci.sh` aufrufen (Datei liegt außerhalb dieses Workstreams).
- TODO: Export-Endpunkt in `apps/api` (z. B. GET /api/delegations/<id>/ucan) für die tatsächliche Ausgabe verifizierter Ketten (außerhalb dieses Workstreams).
- Die physische Passkey-/Hardware-Abnahme bleibt wie bisher deferred.

## Nachweise

- Vektoren: [ucan-bridge-v1.json](vectors/ucan-bridge-v1.json) — 3 Fixtures, 12 Fälle (positiv und Denial: Ablauf, falsche Audience, falscher Issuer, Signatur, Capability-Eskalation), 26 ungültige Tokens.
- Laufprotokoll: [ucan-bridge.json](evidence/ucan-bridge.json).
