# HeavenKey Identity: lokaler Passkey-/SSO-Pilot

Dieser Pilot macht den nächsten Produktschritt ausführbar: Registrierung ohne Nutzerpasswort, Anmeldung per Passkey und SSO über zwei getrennte Demo-Anwendungen. Er verbindet keine echten Supersynergy-Konten und verarbeitet keine echten Identitätsnachweise.

[Roadmap](../../docs/ROADMAP.md) · [Due Diligence und Pro/Contra](../../docs/IDENTITY-DUE-DILIGENCE.md) · [To-dos und Unteraufgaben](../../docs/IDENTITY-BACKLOG.md)

## Voraussetzungen

- Node.js 24+, Python 3.12+, Java 21 und Keycloak **26.8.1**.
- Freie lokale Ports 18370–18372. Alle Dienste binden ausschließlich an `127.0.0.1`.
- Chrome/Chromium mit WebAuthn; Browserprüfung über Playwright nutzt virtuelle CTAP2-Schlüssel.
- Ausschließlich erfundene Kontodaten. Laufzeit standardmäßig 15 Minuten; Ctrl+C beendet den Pilot.

Die geprüfte Keycloak-Distribution stammt aus dem [offiziellen Release](https://github.com/keycloak/keycloak/releases/tag/26.8.1):

```text
keycloak-26.8.1.tar.gz
SHA-256: 4e2740b181faa2ea623a1c2ecf00855935311e546046e2f857615a47ed24cbe8
```

## Starten

Im Repository:

```sh
npm ci --ignore-scripts --prefix apps/identity-pilot
export JAVA_HOME=/absoluter/pfad/zum/jdk-21
export KEYCLOAK_HOME=/absoluter/pfad/zu/keycloak-26.8.1
python3 scripts/identity_pilot.py
```

Öffne `http://office.localhost:18371`. Wähle beim ersten Mal **HeavenKey neu einrichten**. Verwende ausschließlich erfundene Angaben und registriere einen Passkey. Öffne danach `http://portal.localhost:18372` und wähle **Mit HeavenKey anmelden**. Die vorhandene Login-Sitzung wird verwendet; die beiden Anwendungen erhalten unterschiedliche pseudonyme Kennungen.

`*.localhost` wird von aktuellen Chromium-Browsern lokal aufgelöst. Die Adresse `localhost:18370` ist die gemeinsame RP-ID/Anmelde-Origin; sie ist keine spätere Produktivdomain. Bei abweichender Auflösung keine fremde öffentliche Domain oder einen öffentlichen Tunnel einsetzen.

Der Starter erzeugt zufällige administrative Bootstrap- und Client-Zugangsdaten in einem privaten temporären Verzeichnis. Diese technischen Testserver-Zugangsdaten sind keine Nutzerpasswörter. Sie werden nicht ausgegeben, nicht ins Repository geschrieben und nicht an den Browsertest weitergereicht. Die Keycloak-Instanz verwendet einen eigenen temporären Bestand. Ein neuer Start beginnt ohne vorherige Konten. Es werden keine vorhandenen Tresore geöffnet.

**Beenden:** Ctrl+C oder Ablauf der Laufzeit beendet beide Verbraucher und Keycloak und entfernt temporäre Daten. Ein harter Prozess-/Systemabbruch kann Artefakte im temporären Betriebssystemspeicher hinterlassen. Das ist keine Garantie forensischer Löschung.

## Prüfungen

```sh
npm test --prefix apps/identity-pilot
npm audit --prefix apps/identity-pilot
node apps/identity-pilot/node_modules/playwright-core/cli.js install chromium --only-shell
python3 scripts/identity_pilot.py --e2e --seconds 300
```

Alternativ `CHROME_PATH` auf einen installierten kompatiblen Browser setzen. Die Browserprüfung benötigt eine Umgebung mit den gewöhnlichen Browser-/IPC-Rechten. Eine eingeschränkte Containerumgebung kann den Start verweigern; dann die CI-Abnahme verwenden und keinen Hardware-/Browsererfolg behaupten.

Ein frischer erfolgreicher Lauf schreibt `docs/evidence/identity/pilot.json` mit Quellhashes, Browser-/Node-/Keycloak-Version und den tatsächlich ausgeführten Prüfungen. Vor dem Lauf wird ein alter Erfolgsbeleg entfernt. Der Test meldet keine Schlüssel, Token oder Kontodaten als Nachweis.

## Schutz und Grenzen

- `openid-client` prüft Code-Flow, PKCE, State, Nonce und mit explizit aktivierter Zusatzprüfung auch ID-Token-Signaturen. Keine eigenen JWT-/Signaturprimitive.
- Exakte Callback-Adressen, abgeschaltete Implicit-/Password-/Service-Account-Grants, serverseitige Einmaltransaktionen und Sitzungserneuerung.
- Provider-Requests bleiben auf der konfigurierten lokalen Origin; kein Folgen fremder Redirects. Fremde Hosts oder nicht passende Origin/CSRF werden abgewiesen.
- Nur eine flüchtige Sitzung im HttpOnly-/SameSite-Cookie; keine Tokens in Browserstorage oder API-Antworten.
- HTTP und Cookies ohne Secure-Attribut gelten ausschließlich für diesen Loopback-Pilot. Es existiert kein öffentlicher Betriebsmodus.
- Lokales Logout beendet eine Demo-Sitzung. IdP-SSO und andere Demo-Sitzungen können bis zum Ablauf weiterbestehen; globales Logout/Widerruf bleibt eine Roadmap-Aufgabe.
- Kein BioID, keine Identitäts-/KYC-Prüfung, kein nativer Android-Anbieter-/Telefonnachweis und keine echte Office-Anbindung.
- Virtueller Credential-Import im Test ist ausschließlich Fixture-Übertragung, keine implementierte Geräte-Migrationsfunktion.
- Kein Produktionsbetrieb, Hochverfügbarkeitsnachweis oder externes Audit. Root-CI und mobile Abnahmen bleiben getrennte Oracles.
