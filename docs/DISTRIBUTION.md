# HeavenKey installieren und starten

macOS 14 oder neuer: Entpacke dein Architektur-Paket und ziehe `HeavenKey.app` nach Programme. Doppelklick öffnet das App-Fenster. Die App startet einen eigenen lokalen Dienst; Beenden oder das Schließen des letzten Fensters beendet ihn. Der Kommandozeilen-Starter bleibt für ausdrücklich gestartete Browser-Sitzungen enthalten. Bei einem bereits belegten Port zeigt die App einen Fehler und verbindet sich nicht mit dem fremden Listener.

Windows x64: Entpacke den gesamten Ordner und starte `Start HeavenKey.cmd`. Linux: entpacken und `./start.sh`. Diese beiden Pakete verwenden den Systembrowser; sie enthalten noch kein natives WebView-Fenster. Der Dienst muss während der Nutzung laufen. Windows ist per Cross-Build und Wine prüfbar; Windows Hello und die Windows-Kernel-Sandbox sind ohne Windows-System nicht abgenommen.

Die macOS-App verwendet einen flüchtigen WebKit-Kontext. Tresordaten liegen verschlüsselt im lokalen Dienst. Dateiimporte und Sicherungen nutzen native Auswahldialoge. „Ansicht → Neu laden und Tresor sperren“ entfernt den entsperrten UI-Zustand. „Im Browser öffnen“ öffnet nur die eigene lokale Tresor-Adresse; die App muss weiterlaufen. Ein Passkey im WebView ist kein allgemeiner Hardware-Nachweis: Verwende bei fehlender Unterstützung einen kompatiblen Browser.

Die Pakete haben Prüfsummen und Quellstand-Manifeste. Ad-hoc-Integritätssiegel in macOS sind keine Herausgebersignatur oder Apple-Notarisierung. [Einrichtung und Bedienreise](CUSTOMER-JOURNEY.md).

# Weitere Paketdetails

Der [lokale Agenten-Broker](AGENT-BROKER.md) benötigt zusätzlich einen installierten Chromium-Browser. `--broker-agent` und der [eingeschlossene Agentenstart](AGENT-SANDBOX.md) sind im Programm enthalten; `broker.rs` ist ein optionales Cargo-`-Zscript`-Hilfsskript für die Entwicklung.

Der Release-Kandidat 0.20.0 enthält den lokalen Passwortmanager und den SFTP-/FTPES-Broker für macOS, Windows und Linux. Die [Passwortmanager-Anleitung](PASSWORD-MANAGER.md) beschreibt Einrichtung, Sicherung und Grenzen. Verbindliche Build- und Laufzeitnachweise stehen im Releasebericht.

Die Pakete enthalten Server, Weboberfläche und Lizenzhinweise. Für den Passwortmanager brauchst du einen aktuellen Browser, aber kein Rust, Bun, Python, Docker oder Passkey. Das optionale Zugangslabor verwendet WebAuthn, SQLCipher und eine geschützte Signierschlüsselhülle. Physische Passkeys sind noch nicht abgenommen.

## Paket wählen

| Computer | Paket | Start |
| --- | --- | --- |
| Windows 10/11, x64 | `windows-x64.zip` | Entpacken; `Start HeavenKey.cmd` doppelklicken. |
| macOS, Apple Silicon | `macos-arm64.zip` | Entpacken; `HeavenKey.app` öffnen (macOS 14+). |
| macOS, Intel | `macos-x64.zip` | Entpacken; `HeavenKey.app` öffnen (macOS 14+). |
| Linux, x64 | `linux-x64.tar.gz` | Entpacken; `./start.sh` ausführen. |
| Linux, ARM64 | `linux-arm64.tar.gz` | Entpacken; `./start.sh` ausführen. |

Beim CLI-Starter bleibt das Terminal geöffnet. Er öffnet `http://localhost:18240/passwords/`; falls das nicht klappt, öffne die Adresse selbst. `Ctrl+C` beendet HeavenKey. Die API bindet nur an die lokale IPv4-Adresse. Unter Linux braucht das automatische Öffnen `xdg-open`; die manuelle Adresse funktioniert auch ohne Desktop.

Die Ausgabe ist nicht vom Herausgeber signiert oder von Apple notarisiert. Windows und macOS können eine Herkunftswarnung anzeigen. Prüfe Quelle und SHA256SUMS vor dem Start. Verändere keine globalen Sicherheitseinstellungen. Auf macOS lässt sich eine geprüfte App über „Datenschutz & Sicherheit“ freigeben. Auf Windows ARM ist das x64-Paket nur ein Kandidat für die Betriebssystem-Emulation; eine native ARM64-Ausgabe fehlt.

## Einrichten und Daten behalten

Der Passwortmanager zeigt den Speicherort an und fragt nach einem eigenen Masterpasswort mit mindestens 14 Zeichen. Er benötigt keinen Einrichtungscode. Das Masterpasswort bleibt im Browser; der Server speichert nur die verschlüsselte Hülle in `passwords.sqlite`. Lade eine verschlüsselte Sicherung herunter und prüfe ihre Wiederherstellung. Ohne das damalige Masterpasswort lässt sich eine Sicherung nicht öffnen.

Das getrennte Zugangslabor startest du mit dem Programm ohne `--password-manager`, bei parallelem Betrieb auf einem anderen Port: `./heavenkey --port 18241 --open`. Nur für diesen Modus gelten Einrichtungscode, Passkey-Anmeldung und Signierschlüsselverwahrung. Die weitere Bedienung steht in `docs/USAGE.md` im Quellrepository.

| System | Standardspeicher |
| --- | --- |
| Windows | `%LOCALAPPDATA%\HeavenKey` |
| macOS | `~/Library/Application Support/HeavenKey` |
| Linux | `$XDG_DATA_HOME/HeavenKey` oder `~/.local/share/HeavenKey` |

Für das Zugangslabor bewahrst du den gesamten Datenordner und beide Schutzschlüssel auf: den Datenbankschlüssel (`UAC_STORE_KEY` oder `UAC_STORE_KEY_FILE`, sonst private Konfigurationsdatei) sowie den Schutzschlüssel für `issuer.enc` (Betriebssystem-Keystore oder `HEAVENKEY_KEY_FILE`). Ohne sie sind die Labordaten beziehungsweise der Signierschlüssel nicht verwendbar. Der Passwortmanager verwendet ausschließlich sein Masterpasswort. Ein Update des entpackten Programms behält den Datenordner. Mehrere Instanzen mit demselben Port können nicht gleichzeitig starten. Die Meldung „address already in use“ verlangt, die laufende Instanz zu beenden oder einen anderen Port zu wählen. Bestehende Entwicklerdaten unter `data/` verwendest du ausdrücklich mit `--data-dir data`; sie werden nicht automatisch verschoben.

Optional: `HeavenKey.exe --port 18245 --data-dir "C:\Users\Name\HeavenKey-Test"` beziehungsweise `./heavenkey --port 18245 --data-dir /eigener/pfad`. Der Standardordner liegt im Benutzerprofil; verwende keinen gemeinsam beschreibbaren Ordner. Unix-Ordner erhalten Modus 0700, Schlüsseldateien 0600. Windows nutzt die geerbten Zugriffsrechte des Benutzerprofils. Der Port in der Browser-Erweiterung muss mit dem Server übereinstimmen.

## Browser-Erweiterung

Chrome und Edge verwenden dasselbe Chromium-Paket. Entpacke `extension-chromium.zip`, öffne `chrome://extensions` oder `edge://extensions`, aktiviere den Entwicklermodus und wähle „Entpackte Erweiterung laden“. Wähle den Ordner, in dem `manifest.json` liegt.

Firefox ab Version 140: Entpacke `extension-firefox.zip`; öffne `about:debugging#/runtime/this-firefox` und lade `manifest.json` über „Temporäres Add-on laden“. Diese Installation endet beim Browser-Neustart. Eine dauerhafte Installation im normalen Firefox braucht Mozilla-Signierung; das Paket ist noch unsigniert.

Klicke auf HeavenKey in der Browserleiste, wähle den gewünschten Bereich und dann „HeavenKey öffnen“. Die Erweiterung öffnet den lokalen Passwortmanager oder das separat gestartete Zugangslabor; dessen Port muss zur Auswahl passen. Eine HTTPS-Verbindung ist nur für das Zugangslabor erlaubt. Für die Formularhilfe starte den lokalen Passwortmanager. Erzeuge unter Einstellungen einen Verbindungscode und gib ihn mit dem Dienstport in der Erweiterung ein. Bestätige die optionale Berechtigung für localhost. Gespeichert werden nur Verbindung und eigenes Token. Entsperre den Tresor im Popup; schließe das Popup zum Sperren. Der Dienst muss laufen. Ctrl+Shift+Y beziehungsweise Cmd+Shift+Y öffnet die Erweiterung im Browser. Autofill erfordert eine bewusste Auswahl des Tabs, Profils und der Felder. Die Erweiterung nutzt activeTab, scripting, storage und contextMenus; sie erhält keinen dauerhaften Zugriff auf alle Websites und kein Native Messaging.

Safari verwendet die Weboberfläche direkt; eine Safari-Erweiterung ist nicht enthalten. iOS und Android erhalten hier keine native App. Für den lokalen Dienst auf dem Computer ersetzt ein Mobilbrowser keine spätere HTTPS- und Netzwerkbereitstellung.

## Bauen und prüfen

`python3 scripts/build_portable.py TARGET` baut genau ein Ziel mit vier Build-Jobs. Der OpenSSL-Schritt hat höchstens 13 Minuten, der Rust-Schritt höchstens 20 Minuten. Installiere vorher das passende Rust-Target. Apple-Ziele benötigen macOS mit Xcode Command Line Tools. Windows GNU benötigt MinGW-w64; Linux musl benötigt Zig und cargo-zigbuild. Der Build lädt die offizielle OpenSSL-3.6.5-Quelle, prüft ihre feste SHA256 und bindet sie statisch ein. SQLite ist ebenfalls eingebaut. Committe Quellcode und Dokumentation, bevor `python3 scripts/package_release.py TARGET ...` Pakete und Erweiterungen unter `dist/` erstellt. Ein veränderter oder veralteter Build wird abgelehnt.

Die Windows-Prüfung mit Wine ist ein Laufzeittest einer Windows-EXE in einer Kompatibilitätsumgebung. Sie ersetzt weder Windows Hello noch eine Abnahme auf einem echten Windows-System. GitHub-CI verwendet den lokalen, kurzlebigen Linux-Runner; Windows- und macOS-Builds werden lokal erzeugt.

Quellen: [Rust OpenSSL: vendored](https://docs.rs/openssl/0.10.81/openssl/#vendored), [Wine](https://www.winehq.org/), [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Firefox temporär laden](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/), [Firefox-Signierung](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

## Nutzungsrechte

Offizielle Binärpakete dürfen nach der beiliegenden `LICENSE` persönlich und intern genutzt werden. Weitervertrieb und abgeleitete Produkte brauchen eine gesonderte Erlaubnis. Drittanbieter-Lizenzen und zwingende gesetzliche Rechte bleiben erhalten. Details stehen in `LICENSING.md`.
