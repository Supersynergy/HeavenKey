# Passkey-Plattform 0.7: Implementierung und Grenzen

Dieser Stand erweitert die lokale Vorschau. Eine produktive, verteilte Identity-Plattform, vollwertige Mandantenverwaltung, UCAN-Interoperabilität und die reale Next-Office-Anbindung werden nicht behauptet.

## Architektur

| Ebene | Implementiert |
| --- | --- |
| Menschliche Identität | `webauthn-rs` verifiziert Registrierung und Authentifizierung. Mehrere aktive Credentials gehören zu einer stabilen Konto-ID. |
| Zustimmung | Typisierte Aktionsfreigaben, an Sitzung, Konto, aktiven Signierer und genaue Parameter gebunden; 60 Sekunden, einmalig. |
| Berechtigung | Vorhandene service-signierte Grant- und Delegationsprofile bleiben unverändert. |
| Bequemer Lesezugriff | `/api/read` akzeptiert ausschließlich eine bestehende Grant- oder Delegations-ID, prüft die aktuelle Kontoidentität und aktuelle Rechte und gibt das feste Demo-Dokument zurück. |
| Maschinenidentität | Eigener Ed25519-Schlüssel; service-signierter Auftrag mit Resource, Aktionen, Zeitfenster und optionalem Elternzugang. |
| Lokaler Zieladapter | Synthetischer CRM-Kontakt pro ausstellendem Konto; Leserecht oder eng begrenztes Notiz-Update. |
| Private Inhalte | PRF-gestützter, ausschließlich im Browser entschlüsselter Notiztresor. |
| Schlüsselverwahrung | AES-256-GCM-Umschlag für den lokalen Dienst-Signierschlüssel; Schutzschlüssel im nativen Keystore oder in einer ausdrücklich konfigurierten externen Datei. |

Der Passkey autorisiert die Ausstellung von Rechten. Der Dienst signiert die portablen Rechte mit seinem eigenen Ed25519-Schlüssel. Die API bleibt dafür eine Vertrauensinstanz.

## Konfiguration

| Variable | Bedeutung |
| --- | --- |
| `UAC_PORT` | Lokaler Listener-Port, Standard 18240; Bindung bleibt IPv4-Loopback. |
| `UAC_DATA` | Datenordner; alternativ `--data-dir`. |
| `HEAVENKEY_ORIGIN` | Erwartete kanonische WebAuthn-Origin. Standard `http://localhost:PORT`. Andere Hosts benötigen HTTPS. |
| `HEAVENKEY_PUBLIC_ORIGIN` | Kompatibler alternativer Name für die Origin-Konfiguration; `HEAVENKEY_ORIGIN` hat Vorrang. |
| `HEAVENKEY_RP_ID` | Dauerhafte Passkey-RP-ID, Standard `localhost`. Muss zur Origin gehören und die Validierung von `webauthn-rs` bestehen. |
| `HEAVENKEY_KEY_FILE` | Explizite private 32-Byte-Schutzdatei außerhalb des Datenordners; ersetzt die native Keystore-Auswahl. |

Origin und RP-ID vor dem Anlegen eines neuen Datenbestands festlegen. Die RP-ID wird im Datenbestand festgeschrieben. Ein Bestand mit localhost-Passkeys wird bei einem stillen Wechsel zu einer anderen RP-ID abgewiesen. Ein HTTPS-Reverse-Proxy muss `Host` und `Origin` korrekt erhalten. Dieser PR startet keinen Proxy und veröffentlicht keinen Dienst. Die Origin-/RP-ID-Konfiguration ist keine geprüfte HTTPS-Bereitstellung; der separate Hosting-Vorschlag in PR #23 muss bei einer Zusammenführung abgestimmt werden.

## Neue API-Routen

Alle schreibenden Routen durchlaufen den bestehenden Host-/Origin-Guard und die Größenbegrenzung von 32 KiB. Authentifizierte Routen verwenden die bestehende Bearer-Sitzung. Antworten sind `no-store`; die Erweiterung erhält keine dieser Sitzungen.

| Route | Autorisierung und Funktion |
| --- | --- |
| `GET /api/config` | Öffentliche, nicht geheime Laufzeitkonfiguration und öffentlicher Ausstellerschlüssel. |
| `GET /api/session` | Aktive Sitzung und aktiver Kontopasskey. |
| `POST /api/logout` | Beendet diese Sitzung und ihre offenen Aktionsfreigaben. |
| `GET /api/audit` | Letzte 100 eigenen Pilot-Ereignisse; keine Geheimnisse oder Notiztexte. |
| `POST /api/read` | Sitzungsgebundener Read-only-Aufruf mit aktueller Grant-/Kettenprüfung. |
| `GET /api/recovery` | Status und Anzahl aktiver Passkeys, ohne Code oder Digest. |
| `POST /api/recovery/rotate` | Frische `recovery_rotate`-Freigabe; neuen Einmalcode genau einmal zurückgeben. |
| `POST /api/recovery/disable` | Frische `recovery_disable`-Freigabe. |
| `POST /api/recovery/start` | Hohe Code-Entropie, Versuchslimit und begrenzter Registrierungszustand. |
| `POST /api/recovery/finish` | Neue WebAuthn-Registrierung prüfen, Code atomar verbrauchen, alte Credentials/Sitzungen/Agenten sperren. |
| `GET /api/agents` | Eigene Aufträge und ihre aktuelle effektive Nutzbarkeit. |
| `POST /api/agents` | Frische `agent_create`-Freigabe für die exakte `spec`. |
| `POST /api/agents/revoke` | Frische `agent_revoke`-Freigabe des eigenen Kontos. |
| `POST /api/agents/challenge` | Aktuellen Auftrag und genaue Parameter prüfen; begrenzte 60-Sekunden-Challenge ausgeben. |
| `POST /api/agents/invoke` | Einmalzustand entnehmen, alles erneut prüfen, Ed25519-Schlüsselbesitz prüfen, lokalen Adapter atomar ausführen. |
| `GET /api/vault` | Eigener verschlüsselter Tresor und Version. |
| `POST /api/vault/prepare` | Schema und aktive Kontopasskeys prüfen; exakte typisierte Operation für die verschlüsselten Daten berechnen. |
| `POST /api/vault` | Einmalige `vault_write`-Freigabe und Versionsvergleich; nur verschlüsselte Daten speichern. |

## Agentenprofil

Eigenes experimentelles Profil `heavenkey-agent-v1`, keine UCAN- oder DID-Kompatibilität. Der signierte Body enthält in fester Struct-Reihenfolge `profile`, `id`, `account_id`, `credential_id`, `spec`, `not_before`, `expires_at`. Die Spezifikation enthält `name`, `public_key`, `resource`, sortierte `actions`, `ttl_seconds` und `parent_id`.

Ausstellersignatur: Ed25519 über die UTF-8-Domain `HEAVENKEY-AGENT-GRANT-v1` plus NUL und die Serde-JSON-Kodierung dieses typisierten Bodys. Der gespeicherte Body und seine Signatur werden bei jeder Ausführung erneut geprüft; Datenbankpräsenz allein reicht nicht. Die Profile bestehender Grants werden nicht verändert.

Aufrufsignatur: Ed25519 über `HEAVENKEY-AGENT-INVOKE-v1` plus NUL, SHA-256 der kanonischen Server-Origin, zufällige 32-Byte-Nonce und SHA-256 der typisierten JSON-Invocation. Ihre Feldreihenfolge lautet `id`, `resource`, `action`, `arguments`; Argumente sind lexikografisch sortiert. Das Beispiel-CLI überprüft Origin und Invocation-Prüfsumme vor seiner Signatur. Die Challenge wird bei einem verarbeiteten Signaturversuch verbraucht, auch wenn er fehlschlägt.

Grenzen: höchstens 32 aktive Aufträge pro Konto, 128 offene Challenges insgesamt, acht pro Auftrag, 1–3600 Sekunden Auftragslaufzeit, maximal vier Argumente und begrenzte Textlängen. Ein Gast benötigt einen aktuellen `document`-Elternzugang mit verbleibender Delegationsstufe. Ein Agent kann nicht weiterdelegieren. Beim Aufruf wird auch der autorisierende Kontopasskey erneut auf aktiven Status geprüft.

## Schlüssel und Migration

`crates/keystore` verwendet OpenSSL AES-256-GCM mit zufälliger 96-Bit-Nonce und fester Protokoll-AAD. Der native Schutzschlüssel wird über `keyring` verwahrt; fehlender oder gesperrter Keystore führt zu einem Fehler. Ein fehlender Schutzschlüssel für eine vorhandene `issuer.enc` wird niemals neu erzeugt.

Eine vorhandene private `issuer.key` wird unter demselben Ed25519-Seed migriert: verschlüsselten Umschlag exklusiv temporär schreiben und synchronisieren, umbenennen, erneut lesen und authentifiziert entschlüsseln, dann die alte Datei entfernen. Bei unterbrochener Migration wird die alte Datei nur dann entfernt, wenn sie denselben Schlüssel enthält. Tests prüfen falsche Schutzschlüssel, manipulierte Umschläge, Versionsfehler, Migration und Neustart. Das Entfernen der Datei garantiert keine physische Löschung auf SSD, Snapshots oder Backups.

Die native Keystore-Zuordnung hängt vom kanonischen Datenpfad ab. Vor einem Pfad-/Gerätewechsel oder einer Neuinstallation ist ein gesondertes, geschütztes Backup des Schutzschlüssels beziehungsweise des Betriebssystem-Keystores erforderlich. Die Wiederherstellungsdatei für das Benutzerkonto ist kein Server-Backup.

Die Datenbank bleibt unverschlüsselt. Der separate SQLCipher-Vorschlag in PR #15 wird durch diesen Stand weder gemergt noch ersetzt. Die Cargo- und Speicherkonfigurationen müssen vor einer gemeinsamen Übernahme abgeglichen werden.

## Grenzen und ausstehende Abnahme

- Echte macOS-/Windows-/Linux-Keystores und physische Authentikatoren sind nicht abgenommen. Automatisierte Tests verwenden explizite, getrennte Test-Schutzdateien.
- Browser-PRF-Verfügbarkeit wird zur Laufzeit geprüft; die reine WebAuthn-Verfügbarkeit beweist kein PRF.
- Die Passkey-Abfrage hat keine unabhängige hardwareseitige Anzeige der Transaktionsparameter.
- Native Windows-Dateirechte, signierte Desktop-Pakete, Apple-Notarisierung und Mozilla-Signierung sind offen.
- Die API ist ein Einzelprozess mit SQLite und In-Memory-Challenges. Kein Versprechen von sofortigem Widerruf bei verteilten/offline ausgeführten Aktionen.
- Der lokale CRM-Adapter ist ein Beispiel mit synthetischen Daten. Reale Next-Office-Mandanten und externe Aktionen benötigen eine gesonderte Integration und Abnahme.

Primärquellen: [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/), [W3C PRF-Erklärung](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md), [Keyring 3.6.3](https://docs.rs/keyring/3.6.3/), [WebCrypto](https://www.w3.org/TR/WebCryptoAPI/).
