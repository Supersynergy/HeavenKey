# HeavenKey Gate: Offline-Durchsetzung und `hkv`

Version 0.7 ergänzt zwei Werkzeuge rund um das [Delegationsformat](DELEGATION-CONTRACT.md):

- `uac-gate` (`apps/gate/`): ein minimaler Dienst, der eine vorgelegte Delegationskette **offline** gegen einen Issuer-Schnappschuss prüft und erst dann ein Demo-Dokument ausgibt.
- `hkv` (`crates/verifier/src/bin/hkv.rs`): ein Kommandozeilenwerkzeug, das Issuer-Schlüssel ableitet, Token inspiziert und Präsentationen ohne laufende API prüft.
- `GET /api/issuer` in `uac-api`: ein öffentlicher Endpunkt, der den für die Offline-Prüfung nötigen Issuer-Schnappschuss liefert.

## GET /api/issuer

Die API liefert unter `GET /api/issuer` ohne Anmeldung genau dieses JSON:

```json
{"profile": "heavenkey-delegation-v1", "issuer": "<base64url ohne Padding, 32 Byte Ed25519-Prüfschlüssel>", "revoked": ["<Delegations-ID base64url>", ...], "time": <Unix-Sekunden>}
```

`revoked` enthält die IDs aller Delegationszeilen mit `revoked=1`; die IDs liegen bereits als base64url von `delegation::id` vor. Der Endpunkt gibt keine Sitzungsdaten, Token oder Kontoinformationen aus — nur den öffentlichen Prüfschlüssel, die Widerrufliste und die Serverzeit. Die API bindet ohnehin nur an localhost.

## uac-gate

`uac-gate` ist eine Durchsetzungsstelle (Enforcement Point) als Labor-Demonstration: Der Dienst kennt keine Datenbank, keine Sitzungen und keine Passkeys. Er lädt beim Start einen Issuer-Schnappschuss und entscheidet jede Anfrage allein anhand der vorgelegten Kette.

### Start

```sh
# Modus 1: Schnappschuss von der laufenden API holen und auffrischen
uac-gate --issuer-url http://localhost:18240 --snapshot-ttl 60 --port 18242

# Modus 2: rein offline — Schnappschuss aus einer Datei (gleiche JSON-Form)
curl -s http://localhost:18240/api/issuer > issuer-snapshot.json
uac-gate --snapshot-file issuer-snapshot.json
```

- Genau eine der Optionen `--issuer-url` oder `--snapshot-file` ist Pflicht; ohne beide verweigert der Dienst den Start mit einer klaren Meldung.
- Ist die API im `--issuer-url`-Modus beim Start unerreichbar, versucht der Dienst es kurz (zehnmal im Abstand von 300 ms, jede Anfrage mit fünf Sekunden Zeitlimit) und bricht dann mit einer klaren Fehlermeldung ab.
- `--snapshot-ttl` (Standard 60 s) steuert das Aktualisierungsintervall im `--issuer-url`-Modus. Schlägt eine Aktualisierung fehl, bleibt der letzte gültige Schnappschuss aktiv.
- Der Port ist 18242, überschreibbar mit `--port`, einem nackten Positionsargument oder `UAC_GATE_PORT`.
- `GET /health` liefert `{"status":"ok","mode":"heavenkey-gate"}`.

### Präsentation und Entscheidung

`GET /document` verlangt den Header `X-HeavenKey-Authorization` mit base64url-kodiertem (ohne Padding) JSON:

```json
{"chain": ["<Delegations-Token>", "... von Wurzel bis Blatt"], "holder": "<Credential-ID base64url>", "resource": "urn:uac:lab:document", "action": "Read"}
```

Jedes Kettenglied ist der JSON-Token eines signierten `Signed<DelegationGrant>` (wie in der `delegations`-Tabelle der API gespeichert). Die Prüfung dekodiert jedes Glied mit `uac_verifier::delegation::decode`, prüft `verify_structure` und `verify_chain` mit dem Kontext `{Wurzel = Issuer-Schlüssel aus dem Schnappschuss, verified_holder = sha256(decodierte Holder-Credential-ID), resource, action, now, revoked = Schnappschuss-Menge}` und verlangt zusätzlich, dass `leaf.body.audience` dem Holder-Subjekt entspricht — die Präsentation ist an den Holder gebunden. `resource` muss `urn:uac:lab:document` und `action` muss `Read` sein; die Gate gibt ausschließlich dieses Demo-Dokument heraus.

Bei Erfolg antwortet `200` mit dem Demo-Dokument. Fehler liefern `403` mit `{"error": "<code>"}` und einem groben Code: `expired` (Zeitfenster), `revoked` (Widerruf im Schnappschuss), `denied` (Signatur, Kette, Rechte, Holder), `malformed` (Kodierung/Grenzen). Ein fehlender Header liefert `401` mit `{"error":"authorization_required"}`.

### Bedrohungsmodell und Grenzen

Was die Gate abdeckt:

- **Offline-Durchsetzung:** Die Entscheidung fällt ohne die API. Nötig ist nur der Schnappschuss — passend zu vernetzten, aber zeitweise getrennten Laborumgebungen.
- **Holder-Bindung auf Besitzebene:** Die Blatt-Audience muss `sha256(holder credential_id)` sein. Wer die Kette plus fremde Credential-ID weiterreicht, scheitert. Das ist bewusst nur eine Laborbindung: **kein Signaturbesitznachweis** — wer Kette und Credential-ID gemeinsam entwendet, kann sie vorzeigen.
- **Widerruf-Frische:** Der Schnappschuss ist so frisch wie `--snapshot-ttl`. Ein innerhalb des Intervalls widerrufener Zugang bleibt bis zur nächsten Aktualisierung gültig; im Dateimodus gilt der Stand der Datei.
- **Kein Replay-Schutz:** Die Präsentation enthält keine Nonce und kein Zeitstempelfeld des Halters — eine abgehörte gültige Präsentation ist bis zum Ablauf der Kette wiederverwendbar.
- **Nicht abgedeckt:** TLS/Kanalabsicherung (die Laborziele laufen auf localhost), Schlüsselrotation des Issuers außerhalb des Schnappschusses, UCAN-/DID-Fremdprofile, DoS-Begrenzung jenseits der vorhandenen Größenlimits (32 KB Präsentation, 64 KB Schnappschuss), Zuständigkeit für andere Ressourcen oder Aktionen als `Read`.

## hkv — Verifizierungswerkzeug

Installieren ohne neue Abhängigkeiten aus dem Workspace:

```sh
cargo install --locked --path crates/verifier   # legt `hkv` ins PATH
```

Jeder Unterbefehl kennt `--help`. Fehlerfälle enden mit Code 2, `verify`/`grant-verify` geben Code 1 bei Ablehnung zurück.

### `hkv pubkey`

```sh
hkv pubkey --issuer-key data/issuer.key
```

Liest die 32-Byte-Seed-Datei im `issuer.key`-Format der API und gibt den Ed25519-Prüfschlüssel als base64url aus — identisch zum `issuer`-Feld von `/api/issuer`.

### `hkv inspect`

```sh
hkv inspect --input token.json
```

Dekodiert einen Delegations-Token (Profil `heavenkey-delegation-v1`) oder ein älteres Grant-Token und gibt eine lesbare Zusammenfassung aus: Format, ID, Issuer, Delegator, Audience, Ressource, Aktionen, `not_before`/`expires_at`, `remaining_delegations`, Parent und Nonce.

### `hkv verify`

```sh
hkv verify --issuer <b64url-Prüfschlüssel> --input praesentation.json \
    [--revoked <Delegations-ID> ...] [--now <Unix-Sekunden>]
```

Prüft ein Präsentationsdokument in derselben Form wie der Gate-Header (`{"chain":[...],"holder":...,"resource":...,"action":...}`) gegen den genannten Issuer-Schlüssel und eine optionale Widerrufliste. `--now` setzt die Prüfzeit für reproduzierbare Tests. Ausgabe `{"allowed":true}` oder `{"allowed":false,"reason":<code>}` mit denselben groben Codes wie die Gate.

### `hkv grant-verify`

```sh
hkv grant-verify --issuer <b64url-Prüfschlüssel> --input grant-anfrage.json [--now <unix>]
```

Prüft das ältere (nicht delegierte) Grant-Format über `authorize_passkey_grant`. Eingabeform:

```json
{"grant": <signiertes Grant-Objekt>, "holder": "<Credential-ID base64url>", "resource": "<urn>", "action": "Read", "revoked": false, "now": <unix, optional>}
```

`holder` wird wie bei `verify` als `sha256` der decodierten Credential-ID gegen die Grant-Audience geprüft.

## Beispiel: Ende-zu-Ende ohne Browser

```sh
cargo run -p uac-api &                                  # API auf :18240
cargo run -p uac-gate -- --issuer-url http://localhost:18240 &
TOKEN=$(…)                                            # Delegations-Token aus /api/delegations
PRES=$(python3 -c 'import json,base64,sys;print(base64.urlsafe_b64encode(json.dumps({"chain":[sys.argv[1]],"holder":"<cred-b64>","resource":"urn:uac:lab:document","action":"Read"}).encode()).rstrip(b"=").decode())' "$TOKEN")
curl -s -H "X-HeavenKey-Authorization: $PRES" http://localhost:18242/document
```

## Verifikation

`cargo test -p uac-gate` startet das echte Binary auf zufälligen Ports mit synthetischen Ketten (ed25519-dalek + `delegation::sign`) und deckt Erfolg, widerrufenes Blatt, Ablauf, falschen Holder, manipulierte Signatur, falsche Ressource/Aktion, fehlenden und ungültigen Header sowie Schnappschuss-Aktualisierung über `--issuer-url` ab. Der Pfad `--snapshot-file` bleibt rein lokal; physische Passkeys und Netzwerkangriffe bleiben separate Prüfungen.
