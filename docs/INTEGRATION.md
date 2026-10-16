# Integration: uac-gate

`apps/gate` liefert `uac-gate`: ein eigenständiges Autorisierungs-Gate vor einer geschützten Ressource. Es ist der Nachweis „Autorisierung am tatsächlichen Ausführungspunkt" aus der Roadmap (Externe Integrationen): Die Delegationskette wird am Punkt geprüft, an dem der Zugriff stattfindet — nicht in der Anwendung, die den Zugang ausgestellt hat.

Das Gate prüft `heavenkey-delegation-v1`-Ketten **offline** gegen `uac-verifier`: Signatur jeder Stufe gegen den vertrauten Issuer-Schlüssel, Kettenbindung (parent/delegator/audience), Budget- und Tiefengrenzen (höchstens fünf Glieder), Gültigkeit zum Auswertungszeitpunkt und Widerruf über eine gelesene Snapshot-Datei. Ein laufender `uac-api`-Prozess ist nicht nötig. Das Gate gilt deny-by-default: Jede Abweichung endet in `403 delegation_denied`, ohne Details nach außen zu geben.

## Bedienung

```sh
uac-gate \
  --listen 127.0.0.1:18242 \
  --resource urn:uac:lab:document \
  --resource-file /pfad/zur/ressource \
  --issuer-key /pfad/issuer.key \
  --revocations /pfad/revocations.json
```

| Flag | Env | Bedeutung |
| --- | --- | --- |
| `--listen` | `UAC_GATE_LISTEN` | Bind-Adresse, Standard `127.0.0.1:18242` |
| `--resource` | `UAC_GATE_RESOURCE` | Ressourcen-URN, die die Kette gewähren muss (Standard `urn:uac:lab:document`) |
| `--resource-file` | `UAC_GATE_RESOURCE_FILE` | Geschützte lokale Datei (Pflicht) |
| `--issuer-key` | `UAC_GATE_ISSUER_KEY` | Vertrauter Issuer-Schlüssel: 32 Rohbytes oder 64 Hex-Zeichen (Pflicht) |
| `--revocations` | `UAC_GATE_REVOCATIONS` | Widerruf-Snapshot als JSON (Pflicht) |
| `--now` | `UAC_GATE_NOW` | Fixierter Auswertungszeitpunkt in Sekunden — Labor-/Replay-Hilfe, Standard ist die Systemzeit |

Flags schlagen Env-Werte. Fehlt eine Pflichtangabe oder ist Schlüssel/Snapshot/Ressource beim Start unlesbar, endet der Start mit Fehler. Der Issuer-Key ist ein öffentlicher Verifizierschlüssel; das Gate verarbeitet keine Secrets und schreibt keine sensiblen Daten ins Log — pro Anfrage nur die Entscheidung mit interner Fehlerklasse (z. B. `Chain(Revoked)`).

## Schnittstellen

- `GET /health` → `200 {"status":"ok","profile":"heavenkey-delegation-v1","max_chain":5}`
- `POST /access` mit JSON-Body:

```json
{
  "chain": [ {"body": {…}, "signature": […]}, … ],
  "holder": [32 Bytes als Array],
  "action": "Read"
}
```

`chain` ist die signierte Delegationskette (1–5 `Signed<DelegationGrant>` im Format aus `docs/DELEGATION-CONTRACT.md`), `holder` das 32-Byte-Kontosubjekt, als das der Client auftritt. `action` ist optional; nur `Read` wird bedient. Antworten:

- `200` mit `application/octet-stream`: die Dateibytes — nur bei gültiger, aktueller, nicht widerrufener Kette, deren Blatt-Audience `holder` ist und die `Read` auf die konfigurierte Ressource gewährt.
- `403 {"allowed":false,"reason":"delegation_denied"}`: jede Verifikationsverletzung (Signatur, Kette, Eskalation, Zeit, Widerruf, Audience, fehlende Aktion, unlesbarer Snapshot).
- `400 {"allowed":false,"reason":"invalid_request"}`: ungültiger Request-Body (kein JSON, fehlende/unbekannte Felder, falsche Byte-Längen). Body-Limit 64 KiB.

## Widerruf-Snapshot

Die Widerrufliste ist eine JSON-Datei, die der Betriebs-Layer schreibt (z. B. aus dem Delegationsbestand der API exportiert). Das Gate liest sie **bei jeder Anfrage neu** — ein aktualisierter Snapshot greift ohne Neustart:

```json
{
  "version": 1,
  "generated_at": 1700000000,
  "revoked": ["<Grant-ID als 64-stelliges Hex>", "…"]
}
```

`version` muss `1` sein; `generated_at` ist informativ. IDs sind die SHA-256-Identifier aus `delegation::id` (Hex, wie `id_hex` in `docs/vectors/delegation-v1.json`). Grenzen: 1 MiB Datei, 16 384 Einträge. Unlesbare, zu große oder invalide Dateien lassen das Gate **fail-closed** verweigern — eine fehlende Widerrufliste öffnet niemals Zugang. Weil jede Stufe der Kette gegen die Menge geprüft wird, sperrt der Widerruf eines Elternglieds automatisch alle Nachkommen.

## Ressourcen-Wahl

Geschützt wird eine **konfigurierbare lokale Datei** statt einer TCP-Weiterleitung an einen Upstream-Port. Begründung: Die Datei ist ohne zweiten Prozess deterministisch prüfbar — Test und Nachweis vergleichen die zurückgelieferten Bytes direkt. Eine TCP-Weiterleitung (Kettenprüfung bei Verbindungsaufbau, danach Byte-Relay) bleibt als Erweiterung denkbar und ist hier bewusst nicht gebaut — sie brächte ein zweites Prozess-Modell ohne Mehrwert für den Offline-Nachweis.

## Grenzen

- **Kein TLS im Gate.** HTTPS-Terminierung, Client-Authentifizierung und Port-Freigabe gehören dem Betriebs-Layer (Reverse-Proxy, mTLS, Firewall). Das Gate bindet standardmäßig an Loopback.
- **Halter-Bindung ist Aliassebene.** `holder` ist ein Kontosubjekt wie in delegation-v1 — kein Schlüssel. Das Gate beweist „die Kette nennt dieses Subjekt"; der Nachweis, dass der Anrufer dieses Subjekt tatsächlich ist (Passkey-Sitzung, mTLS-Identität), bleibt dem Betriebs-Layer überlassen — analog zur API, die die Audience an die verifizierte WebAuthn-Zeremonie bindet.
- **Snapshot-Aktualität.** Widerrufe gelten ab dem Stand der Datei; ein veralteter Snapshot veraltet das Verbot. Einen Neustart braucht es nicht — wohl aber einen Writer, der den Snapshot frisch hält.
- **Nur Lesen, nur Datei.** Eine einzelne URN, `Read`, Rohbytes. `Write`/`Unlock` und andere Ausführungspunkte sind bewusst nicht angebunden.
- **Offline, kein UCAN-Anspruch.** Das Wire-Format bleibt experimentell; das Gate ist keine UCAN-Bridge.
- **Physische Passkey-/Hardware-Prüfung bleibt deferred** — der Laborpfad nutzt die synthetischen Vektoren.

## Nachweis

`docs/evidence/uac-gate.json` protokolliert Prüfschritte und Live-Lauf: 15 Unit-/HTTP-Tests (`cargo test --locked --offline -p uac-gate`) gegen die synthetischen Fixtures aus `docs/vectors/delegation-v1.json` — gültige Kette, abgelaufen, direkt und über den Elternteil vererbt widerrufen, falsche Audience, manipulierte Signatur, Tiefen-/Budgetverletzung, fail-closed-Snapshot — plus echter HTTP-Lauf mit `200`-Freigabe, `403` nach Snapshot-Widerruf ohne Neustart und `400` bei ungültigem Body. Verifikationsregeln und Fehlerklassen teilt das Gate mit `crates/verifier/src/delegation.rs` (Delegation-v1-Vertrag: `docs/DELEGATION-CONTRACT.md`).
