# HeavenKey-Pakete und Browser-Erweiterungen

Die bisher veröffentlichten Pakete sind 0.6. Der neue 0.7-Quellstand ergänzt Funktionen und Schlüsselverwahrung; siehe [bebilderte Installation](INSTALLATION.md). Neue Desktop-Binärpakete und ihre Plattformabnahme sind separat ausstehend.

Die Pakete enthalten den Server, die Weboberfläche und Lizenzhinweise. Du brauchst einen aktuellen Browser mit WebAuthn, aber kein Rust, Bun, Python oder Docker. HeavenKey ist eine lokale Vorschau mit einem Demo-Dokument. Die Datenbank ist unverschlüsselt; physische Passkeys sind noch nicht abgenommen.

## Paket wählen

| Computer | Paket | Start |
| --- | --- | --- |
| Windows 10/11, x64 | `windows-x64.zip` | Entpacken; `Start HeavenKey.cmd` doppelklicken. |
| macOS, Apple Silicon | `macos-arm64.zip` | Entpacken; `Start HeavenKey.command` doppelklicken. |
| macOS, Intel | `macos-x64.zip` | Entpacken; `Start HeavenKey.command` doppelklicken. |
| Linux, x64 | `linux-x64.tar.gz` | Entpacken; `./start.sh` ausführen. |
| Linux, ARM64 | `linux-arm64.tar.gz` | Entpacken; `./start.sh` ausführen. |

Das Terminal bleibt geöffnet. Der Starter öffnet `http://localhost:18240`; falls das nicht klappt, öffne die Adresse selbst. `Ctrl+C` beendet HeavenKey. Die API bindet nur an die lokale IPv4-Adresse. Unter Linux braucht das automatische Öffnen `xdg-open`; die manuelle Adresse funktioniert auch ohne Desktop.

Die Vorschau ist nicht vom Herausgeber signiert oder von Apple notarisiert. Windows und macOS können eine Herkunftswarnung anzeigen. Prüfe Quelle und SHA256SUMS vor dem Start. Verändere keine globalen Sicherheitseinstellungen. Auf macOS lässt sich eine geprüfte App über „Datenschutz & Sicherheit“ freigeben. Auf Windows ARM ist das x64-Paket nur ein Kandidat für die Betriebssystem-Emulation; eine native ARM64-Ausgabe fehlt.

## Einrichten und Daten behalten

Der Server zeigt den Speicherort und den Pfad zur Datei `owner-bootstrap.txt` an. Öffne diese Textdatei lokal und übertrage den Einrichtungscode in das Feld für die Eigentümer-Einschreibung. Der Code wird weder in URLs noch in der Browser-Erweiterung abgelegt. Gäste registrieren sich ohne Einrichtungscode. Die weitere Bedienung steht in `docs/USAGE.md` im Quellrepository.

| System | Standardspeicher |
| --- | --- |
| Windows | `%LOCALAPPDATA%\HeavenKey` |
| macOS | `~/Library/Application Support/HeavenKey` |
| Linux | `$XDG_DATA_HOME/HeavenKey` oder `~/.local/share/HeavenKey` |

Bewahre den gesamten Datenordner zusammen auf. Ein Update des entpackten Programms behält diesen Ordner. Mehrere Instanzen mit demselben Port können nicht gleichzeitig starten. Die Meldung „address already in use“ verlangt, die laufende Instanz zu beenden oder einen anderen Port zu wählen. Bestehende Entwicklerdaten unter `data/` verwendest du ausdrücklich mit `--data-dir data`; sie werden nicht automatisch verschoben.

Optional: `HeavenKey.exe --port 18245 --data-dir "C:\Users\Name\HeavenKey-Test"` beziehungsweise `./heavenkey --port 18245 --data-dir /eigener/pfad`. Der Standardordner liegt im Benutzerprofil; verwende keinen gemeinsam beschreibbaren Ordner. Unix-Ordner erhalten Modus 0700, Schlüsseldateien 0600. Windows nutzt die geerbten Zugriffsrechte des Benutzerprofils. Der Port in der Browser-Erweiterung muss mit dem Server übereinstimmen.

## Browser-Erweiterung

Chrome und Edge verwenden dasselbe Chromium-Paket. Entpacke `extension-chromium.zip`, öffne `chrome://extensions` oder `edge://extensions`, aktiviere den Entwicklermodus und wähle „Entpackte Erweiterung laden“. Wähle den Ordner, in dem `manifest.json` liegt.

Firefox: Entpacke `extension-firefox.zip`; öffne `about:debugging#/runtime/this-firefox` und lade `manifest.json` über „Temporäres Add-on laden“. Diese Installation endet beim Browser-Neustart. Eine dauerhafte Installation im normalen Firefox braucht Mozilla-Signierung; das Paket ist noch unsigniert.

Klicke auf HeavenKey in der Browserleiste, wähle den gewünschten Bereich und dann „HeavenKey öffnen“. Im 0.7-Quellstand öffnet die Erweiterung wahlweise localhost oder eine ausdrücklich eingerichtete HTTPS-Installation; sie speichert nur die Verbindungseinstellung. Sie startet keinen Server und liest keine besuchten Seiten. Anmeldung, Schlüsselverwaltung und Freigaben bleiben auf der geprüften WebAuthn-Origin. Sie fordert keine Webseiten-, Speicher- oder Native-Messaging-Berechtigung an.

Safari verwendet die Weboberfläche direkt; eine Safari-Erweiterung ist nicht enthalten. iOS und Android erhalten hier keine native App. Für den lokalen Dienst auf dem Computer ersetzt ein Mobilbrowser keine spätere HTTPS- und Netzwerkbereitstellung.

## Bauen und prüfen

`python3 scripts/build_portable.py TARGET` baut genau ein Ziel mit vier Build-Jobs. Der OpenSSL-Schritt hat höchstens 13 Minuten, der Rust-Schritt höchstens 20 Minuten. Installiere vorher das passende Rust-Target. Apple-Ziele benötigen macOS mit Xcode Command Line Tools. Windows GNU benötigt MinGW-w64; Linux musl benötigt Zig und cargo-zigbuild. Der Build lädt die offizielle OpenSSL-3.6.5-Quelle, prüft ihre feste SHA256 und bindet sie statisch ein. SQLite ist ebenfalls eingebaut. Committe Quellcode und Dokumentation, bevor `python3 scripts/package_release.py TARGET ...` Pakete und Erweiterungen unter `dist/` erstellt. Ein veränderter oder veralteter Build wird abgelehnt.

Die Windows-Prüfung mit Wine ist ein Laufzeittest einer Windows-EXE in einer Kompatibilitätsumgebung. Sie ersetzt weder Windows Hello noch eine Abnahme auf einem echten Windows-System. GitHub-CI verwendet den lokalen, kurzlebigen Linux-Runner; Windows- und macOS-Builds werden lokal erzeugt.

Quellen: [Rust OpenSSL: vendored](https://docs.rs/openssl/0.10.81/openssl/#vendored), [Wine](https://www.winehq.org/), [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Firefox temporär laden](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/), [Firefox-Signierung](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
