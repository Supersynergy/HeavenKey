<div align="center">

# HeavenKey

**Zugang beginnt mit Zustimmung.**

Passwörter lokal verschlüsseln und offline verwalten. Zusätzlich: mit Passkeys anmelden, zeitlich begrenzte Zugänge teilen und Weitergaben kontrollieren.

[![CI](https://github.com/Supersynergy/HeavenKey/actions/workflows/ci.yml/badge.svg)](https://github.com/Supersynergy/HeavenKey/actions/workflows/ci.yml) ![Version](https://img.shields.io/badge/version-0.8_preview-c5a36a)

<p align="center">
  <img src="docs/assets/heavenkey-hero-square.png" alt="HeavenKey: ein schwebender Schlüssel vor dem Himmelstor" width="560">
</p>

[Bebilderte Installation](docs/INSTALLATION.md) · [Passkey-Anleitung](docs/PASSKEY-GUIDE.md) · [Agenten](docs/AGENT-GUIDE.md) · [Funktionen](#funktionen) · [Browserdemo](docs/BROWSER-DEMO.md) · [Ausprobieren](#ausprobieren) · [Benutzung](docs/USAGE.md) · [Roadmap](docs/ROADMAP.md)

</div>

## Schnellstart

![HeavenKey in drei Schritten starten](docs/images/01-installation.svg)

**Version 0.8.0, lokale Vorschau.** Wähle dein Paket unter [Releases](https://github.com/Supersynergy/HeavenKey/releases/tag/v0.8.0-preview.1), entpacke es und starte den enthaltenen Starter. Er öffnet den lokalen Passwortmanager. Du brauchst einen aktuellen Browser; Rust, Bun, Konto und Internet sind für diesen Modus nicht erforderlich. Siehe [Passwortmanager](docs/PASSWORD-MANAGER.md), [Plattformpakete](docs/DISTRIBUTION.md) und [Enpass plus 20 Kandidaten: Gap-Analyse](docs/PASSWORD-MANAGER-GAPS.md).

Für die Entwicklung aus dem Quellcode:

Installiere Rustup und Python 3.11+ sowie Bun **1.4.2**. Starte danach im Projektordner:

```sh
python3 scripts/first_run.py
```

Windows: `py -3 scripts/first_run.py`. Der Assistent baut und öffnet den Passwortmanager. `--lab` startet stattdessen das bisherige Passkey-Zugangslabor.

## Funktionen

| Funktion | Was du damit machen kannst |
| --- | --- |
| Lokaler Passwortmanager | Logins mit Masterpasswort anlegen, bearbeiten, suchen und löschen; Tags und Favoriten verwenden. Kein Onlinekonto erforderlich. |
| Passwörter und TOTP erzeugen | Zufällige Passwörter erzeugen und zeitbasierte Einmalcodes lokal berechnen. |
| Tresor sichern | Verschlüsseltes Backup herunterladen und wiederherstellen; Login-CSV lokal prüfen und importieren. |
| Tresor sperren | Manuell und nach Inaktivität sperren; Schlüssel und Einträge bleiben nur während der Entsperrung im Browser. |
| Mit Passkey anmelden | Ein Konto über WebAuthn erstellen und dich mit einem aktiven Passkey anmelden. |
| Mehrere Passkeys verwalten | Bis zu acht aktive Passkeys verwalten, mit Namen und individuellem Widerruf. Der letzte aktive Schlüssel bleibt geschützt. |
| Zugang teilen | Einem registrierten Gast Leserechte auf das Demo-Dokument geben, gültig für 1–3.600 Sekunden. |
| Weitergabe begrenzen | Festlegen, ob und wie oft ein Gast seinen Zugang weitergeben darf: bis zu vier Weitergaben, höchstens fünf Kettenglieder. |
| Rechte eingrenzen | Nachfolger erhalten höchstens die Rechte und Laufzeit ihres Elternzugangs. |
| Zugang entziehen | Einen Zugang widerrufen und damit auch seine abhängigen Nachfolger sperren. |
| Änderungen bestätigen | Die Details einer Änderung vor der frischen Passkey-Bestätigung prüfen. |
| Zustände behalten | Den Kontozustand lokal speichern; ein Neustart hebt Sperren nicht auf. |
| Einfach lesen | Innerhalb einer aktiven Sitzung mit laufend geprüften Berechtigungen lesen; sensible Änderungen weiterhin frisch bestätigen. |
| Konto wiederherstellen | Einen neuen Passkey mit dem gesicherten Einmalcode einrichten. Alte Schlüssel und Agenten werden gesperrt; offene Sitzungen enden. |
| Signierschlüssel schützen | Schlüssel verschlüsselt speichern; Schutzschlüssel im Betriebssystem-Keystore oder in einer expliziten externen Datei verwahren. |
| Agenten begrenzen | Eigene Maschinenschlüssel, genaue Rechte, Laufzeiten, Schlüsselbesitznachweis und Widerruf; ausführbarer lokaler CRM-Pilot mit synthetischen Daten. |
| Privaten Tresor nutzen | Optional mit PRF-fähigem Passkey lokal entschlüsseln, mehrere Passkeys berechtigen und unabhängigen Offline-Schlüssel sichern. |
| Browser-Erweiterung öffnen | Direkt zu Passkeys, Freigaben, Recovery, Agenten, Tresor und Hilfe; in Chrome, Edge oder Firefox. |

### Ein Beispiel

Du gibst Anna für 30 Minuten Zugang und erlaubst eine Weitergabe. Anna kann Ben Zugang für zehn Minuten geben. Ben kann ihn nicht weitergeben. Widerrufst du Annas Zugang, endet auch Bens Zugriff. Vor der Nutzung prüft HeavenKey die aktuelle Berechtigungskette.

![HeavenKey: Übersicht geteilter Zugänge](docs/evidence/browser-delegation-chain.png)

## Ausprobieren

Die [Browserdemo](docs/BROWSER-DEMO.md) zeigt Teilen, Öffnen und Widerrufen mit Beispieldaten. Sie braucht keine Anmeldung oder Installation. Im Zugangslabor liegt sie unter `/demo/`; der Ordner `apps/demo` funktioniert auch direkt im Browser.

Fertige Pakete für **Windows x64, macOS ARM64/Intel und Linux ARM64/x64** stehen in den [Vorschau-Releases](https://github.com/Supersynergy/HeavenKey/releases). Entpacken und den enthaltenen Starter ausführen; ein aktueller Browser genügt. Rust, Bun und Docker brauchst du nur für die Entwicklung. Die [Paket-Anleitung](docs/DISTRIBUTION.md) erklärt Einrichtung, Datenordner und die Erweiterungen für Chrome, Edge und Firefox.

### Aus dem Quellcode bauen

Voraussetzungen: Rustup, Bun **1.4.2**, `just`, Python 3 und Google Chrome. Auf macOS müssen die Xcode Command Line Tools für den nativen Build installiert sein. Die Rust-Version ist in `rust-toolchain.toml` festgelegt. Das private Repository benötigt GitHub-Zugriff.

```sh
git clone https://github.com/Supersynergy/HeavenKey.git
cd HeavenKey
bun install --frozen-lockfile --ignore-scripts
cargo fetch --locked
just build
just e2e
```

`just e2e` testet den vollständigen Ablauf mit virtuellen Passkeys in einem isolierten Chrome-Browser. Browser, Server und Testdaten werden anschließend entfernt. Ein anderer Chrome-Pfad lässt sich mit `CHROME_PATH=/pfad/zu/chrome just e2e` angeben.

Den Passwortmanager startest du mit `cargo run --locked --offline -p uac-api -- --password-manager --open`. Ohne `--password-manager` startet das separate Zugangslabor. Die [Anleitung](docs/USAGE.md) beschreibt dessen Einrichtung, Schlüsselverwaltung und Zugangsteilung.

## Stand und Grenzen

**Version 0.8 ist eine lokale Vorschau.** Die [Release-Abnahme](docs/PASSWORD-MANAGER-VERIFICATION.md) bindet Prüfungen an Quelle und Pakete. Desktop-Pakete enthalten die Weboberfläche und ihre nativen Bibliotheken. Kompatibilitätsprüfungen ersetzen keine Abnahme von Windows Hello oder physischen Passkeys. Firefox-Erweiterungen sind vorerst temporär installierbar. Kostenpflichtige Runner werden nicht verwendet. Ältere Nachweise stehen unter [0.7-Verifikation](docs/V07-VERIFICATION.md) und [Verifikation](docs/VERIFICATION.md).

Der Passwortmanager schließt die lokale Kernlücke, übertrifft Enpass aber noch nicht im gesamten Funktionsumfang. Browser-Autofill, mobile Apps, Synchronisation, verwaltete Website-Passkeys und ein externes Sicherheits-Audit fehlen. Die Gap-Analyse unterscheidet Herstellerangaben, eigenen Quellstand und ausgeführte Tests.

Die Demo arbeitet mit einem Testdokument. Der Dienst signiert Zugänge und prüft sie online. Der integrierte 0.7-Quellstand verbindet HTTPS-Passkeys, SQLCipher-Datenbank, geschützte Signierschlüssel, Recovery, optionalen PRF-Notiztresor und einen lokalen Agenten-/CRM-Adapter. Das Offline-Gate und die Mandantenbibliothek sind enthalten; die API verwendet weiterhin einzelne Konten und keinen externen Mandantenconnector. Reale Next-Office-Anbindung und UCAN-/DID-Kompatibilität bleiben offen. Die zusammengeführten Entwicklungszweige und Abnahmegrenzen stehen in [Integration](docs/INTEGRATION.md).

## Aufbau

```mermaid
flowchart LR
    P[Passkey] --> W[Weboberfläche · TypeScript]
    W --> A[API · Rust / Axum]
    A --> V[Identität und Zugangsrechte prüfen]
    A --> D[(SQLite · lokale Daten)]
    V --> R[Demo-Dokument]
```

Der Passkey bestätigt dein Konto und die konkrete Aktion. Ein signierter Zugang bestimmt, welche Ressource du nutzen darfst und wie lange. Die API prüft beides vor der Ausführung.

## Dokumentation

- [Bebilderte Installation](docs/INSTALLATION.md)
- [Passkeys, Recovery und Tresor](docs/PASSKEY-GUIDE.md)
- [Agentenprogramm und CRM-Pilot](docs/AGENT-GUIDE.md)
- [Implementierung, APIs und Grenzen](docs/PASSKEY-PLATFORM.md)
- [Benutzung: Einrichten, teilen und widerrufen](docs/USAGE.md)
- [Neu in 0.5: begrenzte Weitergabe](docs/V05-RESULT.md)
- [Roadmap und Zeitplanung](docs/ROADMAP.md)
- [Entwicklung und Tests](docs/DEVELOPMENT.md)
- [API- und Sicherheitsverhalten](docs/SPEC.md)
- [Delegationsformat](docs/DELEGATION-CONTRACT.md)
- [Abhängigkeiten und Lizenzen](docs/DONORS.md)
- [Änderungen](CHANGELOG.md)

## Mitwirken und Rechte

[Beiträge](CONTRIBUTING.md) · [Sicherheitsmeldungen](SECURITY.md) · [Lizenzhinweise](NOTICE.md)

HeavenKey ist ein privates Supersynergy-Projekt mit vorbehaltenen Rechten. Eine Open-Source-Lizenz wurde nicht vergeben. Abhängigkeiten behalten ihre Lizenzen.
