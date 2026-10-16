# Prüfstatus 0.7.0

Stand: **16. Oktober 2026**. Ausgangspunkt: `main` mit Commit `1aa9accabcbde3469e6ed4d3fe15c43ca5c04141`. Dieser Bericht beschreibt die neu implementierte lokale Vorschau, keine Produktionsfreigabe.

## Bestanden

| Prüfung | Ergebnis |
| --- | --- |
| Rust-Tests | 59 bestanden, keine Fehler; einschließlich sechs neuer API-/Autorisierungstests, Keystore-Migration und Recovery-Primitiven. |
| Python-Tests | 22 bestanden; einschließlich Schutz vor Überschreiben bestehender Schutzdateien und vorhandener CI-/Paketierungsprüfungen. |
| Browser-Kryptografie ohne Browser | Zwei Bun-Tests mit echten WebCrypto-Operationen: falscher Schlüssel, falsches Konto, Manipulation, mehrere Passkey-Umschläge und Offline-Wiederherstellung. |
| Oberfläche in simulierter DOM-Umgebung | Ein Bun-Test: tatsächliches HTML/TypeScript, Anmeldung, genaue Aktionsbestätigung, Sicherungsdownload-Zustand, Abmeldung und Bereinigung des Tresors; WebAuthn/HTTP dabei gemockt. |
| Erweiterungs-Popup in simulierter DOM-Umgebung | Ein Bun-Test: unsichere Einstellungen verwerfen, korrektes Ziel öffnen, nur Verbindungseinstellungen speichern. |
| Erweiterungs-URL-Validierung | Lokale Ports, erlaubte Zielbereiche, HTTPS-Origin und Ablehnung von Zugangsdaten/Pfaden/Parametern geprüft. |
| Protokollintegration | 13 Szenarien mit synthetischen P-256-Softwareauthentikatoren über HTTP gegen die echte laufende Rust-API; keine gemockte Signaturprüfung. |
| Beispiel-Agent | Das ausgelieferte CLI führt einen Origin- und aktionsgebundenen Leseaufruf tatsächlich aus. |
| Typen und Rust-Qualität | TypeScript ohne Ausgabe, `cargo fmt --check`, Clippy für alle Targets mit Warnungen als Fehler bestanden. |
| Abhängigkeiten | `cargo deny`, aktuelle RustSec-Prüfung mit `cargo audit` und `bun audit` ohne gefundene Schwachstellen bestanden. Cargo-deny meldet erlaubte Mehrfachversionen nur als Warnungen. |
| Start und Neustart | CLI-Parameter, eingebettete Assets, Registrierungsoptionen und stabiler geschützter Ausstellerschlüssel geprüft. |
| Firefox-Erweiterung | Temporäre Installation im wegwerfbaren Firefox-Profil über Mozilla RDP erfolgreich; keine Manifestwarnungen. Kein Popup-Klick und keine vollständige Browseranmeldung nachgewiesen. |
| Anleitung | Sieben SVG-Bedienillustrationen reproduzierbar erzeugt, gerendert und visuell geprüft. Keine vorgetäuschten Browser-Screenshots. |

Die gesamte zugrunde liegende Prüfliste wurde erfolgreich ausgeführt:

```sh
HEAVENKEY_ADVISORIES_OFFLINE=1 bash scripts/ci.sh check
```

Die Rust-Advisory-Datenbanken waren zuvor mit den Online-Aufrufen aktualisiert worden. Die Protokollintegration verwendet eigene temporäre Daten, separate Schutzdateien und ausschließlich synthetische Identitäten. Sie prüft unter anderem Fremd-Origin, einmalige Freigaben, aktuelle Rechte, Agentenschlüssel, Replay, atomare Kontowiederherstellung, weiterhin nutzbare gültige Codes trotz gedrosselter Fehlversuche, Sperrung alter Passkeys/Agenten und Neustart.

## Hier blockiert

`just check` und `just e2e` enden in dieser Umgebung mit **125**, bevor ihr jeweiliger Auftrag startet. Der unveränderte Befehlswrapper verlangt eine Prozessaufnahme über `ps -axo pid=,ppid=`; der Zugriff scheitert hier. Die Sicherheitsvoraussetzung wurde nicht abgeschwächt. Die oben genannte identische zugrunde liegende Checkliste wurde direkt im Vordergrund mit äußerem Zeitlimit ausgeführt.

Der direkte Chrome-Erweiterungstest erreicht den Browserstart, scheitert aber an der benötigten AF_UNIX-Socket-Erstellung (`Operation not permitted`). Der neue Firefox-WebDriver-Test startet den Hauptprozess, scheitert dann an beschränkten Benutzer-Namensräumen der Content-Prozesse (`/proc/self/uid_map: EPERM`, anschließend Prozessabbruch). Die erfolgreiche reine Firefox-Add-on-Installation darf damit nicht als erfolgreicher Test der gesamten Oberfläche verstanden werden.

Die vorbereiteten Browser-Tests bleiben im Repository und können auf einer geeigneten Testmaschine mit isolierten Profilen und virtuellen Authentikatoren ausgeführt werden. Browser-Sandboxen werden für diesen Nachweis nicht global abgeschaltet. Neue Browser-Screenshots wurden nicht erzeugt.

## Noch separat abzunehmen

- Physische Passkeys, Biometrie und Wiederherstellung auf echten Endgeräten.
- PRF auf tatsächlichen Browser-/Betriebssystem-/Authentikator-Kombinationen.
- Native macOS-/Windows-/Linux-Keystores, deren Sperrung und geschützte Übertragung bei Geräte-/Pfadwechsel.
- Native Windows-Dateirechte, neue Desktop-Builds, Signierung, Apple-Notarisierung und dauerhafte Firefox-Installation mit Mozilla-Signatur.
- Reale Next-Office-Connectoren, HTTPS-Betrieb, vollständige Mandantenverwaltung und verteilte Ausführung. Enthalten ist der lokale synthetische CRM-Pilot.

Maschinenlesbare Nachweise: [Gesamtstatus](evidence/v07-verification.json), [Protokollszenarien](evidence/protocol-e2e.json), [Firefox-Installationsnachweis](evidence/v07-firefox-install.json).
