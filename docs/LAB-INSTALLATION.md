# Separates Passkey-Zugangslabor einrichten

Diese Anleitung bewahrt die bisherigen Laborabläufe. Sie gilt ausschließlich für den Modus **ohne `--password-manager`**, einschließlich der in 0.12.0 enthaltenen Laborfunktionen aus 0.7. Der normale Paket-Starter und `scripts/first_run.py` öffnen heute den Passwortmanager. Dessen [Installation, Masterpasswort und Browser-Autofill](INSTALLATION.md) werden separat erklärt.

Die alten Labor-SVGs sind **schematische Bedienillustrationen aus dem 0.7-Stand, keine Screenshots und keine Hardware-Abnahme**. Eigentümercode, Konto-Recovery und PRF-Notiztresor sind andere Verfahren als das Masterpasswort und die Sicherungsdatei des Passwortmanagers. Bestehende Labordokumentation: [Bedienung](USAGE.md), [Passkeys und Recovery](PASSKEY-GUIDE.md), [Agenten](AGENT-GUIDE.md), [technische Grenzen](PASSKEY-PLATFORM.md).

## Fertiges Paket starten

Lade und prüfe das Paket wie in [Download und SHA-256](INSTALLATION.md#1--download-und-sha-256-prüfen) beschrieben. Öffne ein Terminal im vollständig entpackten Programmordner. Ein eigener Port vermeidet einen Konflikt mit dem Passwortmanager auf 18240.

macOS / Linux:

```sh
./heavenkey --port 18241 --open
```

Windows, in PowerShell:

```powershell
.\HeavenKey.exe --port 18241 --open
```

Öffne `http://localhost:18241/`. Nicht den normalen Paket-Starter doppelklicken: Er ergänzt `--password-manager`. Der Dienst bleibt im Vordergrund; Ctrl+C beendet ihn. Verwende keine für einen anderen Modus gesetzten Umgebungsvariablen. Das Labor benötigt einen entsperrten Betriebssystem-Keystore oder eine ausdrücklich konfigurierte Schutzdatei.

## Aus dem Quellstand starten

Verwende für den Stand dieser Anleitung den Tag `v0.12.0`. **Python 3.11+, Rustup und Bun 1.4.2** werden benötigt; unter Linux zusätzlich die üblichen C-/OpenSSL-Buildwerkzeuge und `pkg-config`, auf macOS die Xcode Command Line Tools. Der Schlüsselbund sollte entsperrt sein.

- [Rustup installieren](https://rustup.rs/) – verwendet die festgelegte Toolchain aus `rust-toolchain.toml`.
- [Bun installieren](https://bun.sh/docs/installation) – die hier festgelegte Version ist **1.4.2**.
- [Python installieren](https://www.python.org/downloads/) – bei Windows den Python Launcher mitinstallieren.

Repository mit deinem berechtigten GitHub-Konto am Tag `v0.12.0` klonen oder diesen Tag als Quell-ZIP herunterladen und entpacken. Öffne ein Terminal im Projektordner:

```sh
python3 scripts/first_run.py --lab --port 18241
```

Unter Windows:

```powershell
py -3 scripts/first_run.py --lab --port 18241
```

Der Assistent prüft die Werkzeuge, lädt festgelegte Abhängigkeiten, baut die Oberfläche und die API und öffnet anschließend HeavenKey. **`just`, Docker und eine Browser-Erweiterung sind für diesen Start nicht erforderlich.** Der erste Build benötigt einige Minuten und Internetzugang; die lokale Nutzung danach benötigt keinen Cloud-Login.

### Dein erster Passkey

![Ersten Passkey einrichten](images/02-erster-passkey.svg)

1. Öffne `http://localhost:18241`, falls der Browser nicht automatisch startet.
2. Das Terminal nennt den Datenordner und den Pfad zu `owner-bootstrap.txt`.
3. Öffne diese Datei als Text, übertrage ihren Inhalt in **„Einrichtungscode · nur für Eigentümer“** und lasse den Kontonamen für den ersten Eigentümer bei `owner`.
4. Wähle **„Passkey erstellen“** und bestätige die Systemabfrage deines Geräts.
5. Wähle danach **„Mit Passkey anmelden“**.
6. Unter **„Meine Passkeys“** einen zweiten, unabhängigen Passkey hinzufügen.
7. Unter **„Wiederherstellung“** einen Einmalcode erstellen und **„Sicherung herunterladen“** wählen.

Ein Gast verwendet einen eigenen Kontonamen mit 3–32 ASCII-Buchstaben/Ziffern/Bindestrichen und lässt den Einrichtungscode leer. Gäste bekommen dadurch keine Eigentümerrechte. Die Eigentümerrolle wird einmalig vergeben.

### Wo liegen die Daten?

| System | Standard-Datenordner |
| --- | --- |
| macOS | `~/Library/Application Support/HeavenKey` |
| Windows | `%LOCALAPPDATA%\HeavenKey` |
| Linux | `$XDG_DATA_HOME/HeavenKey` oder `~/.local/share/HeavenKey` |

Der Dienst schützt seinen Signierschlüssel in `issuer.enc`. Der zugehörige Schutzschlüssel liegt standardmäßig im **macOS-Schlüsselbund, Windows Credential Manager oder Linux Secret Service**. Er wird nicht automatisch in eine Datei zurückgeschrieben, wenn dieser Dienst fehlt oder gesperrt ist.

Der integrierte Quellstand verschlüsselt die Datenbank mit SQLCipher. Für ein vollständiges Server-Backup brauchst du den Datenordner, den Datenbankschlüssel (`UAC_STORE_KEY` oder externe `UAC_STORE_KEY_FILE`, sonst private Konfigurationsdatei) und den Schutzschlüssel für `issuer.enc` (Betriebssystem-Keystore oder `HEAVENKEY_KEY_FILE`). Persönliche Tresorinhalte werden zusätzlich im Browser verschlüsselt. Konto-Recovery und Tresorschlüssel ersetzen dieses Server-Backup nicht. Betriebssystemzugriff auf den laufenden Dienst und ausgelieferter Browsercode bleiben Teil der Vertrauensbasis.

### Linux ohne Desktop-Schlüsselbund / ausdrücklicher Dateibetrieb

Erzeuge einen Schutzschlüssel **außerhalb** des Datenordners. Ein vorhandener Schlüssel wird niemals überschrieben:

```sh
python3 scripts/first_run.py --lab --port 18241 --protection-key-file /absoluter/privater/pfad/issuer-protection.key
```

Die explizite Option erstellt eine neue 32-Byte-Datei mit privaten Dateirechten, falls sie noch nicht existiert. Bei weiteren Starts denselben Pfad verwenden. Für einen schon gebauten Server:

```sh
export HEAVENKEY_KEY_FILE=/absoluter/privater/pfad/issuer-protection.key
./target/debug/uac-api --port 18241 --open
```

**Server-Backup:** Datenordner und zugehörigen Betriebssystem-Keystore beziehungsweise externe Schutzdatei gemeinsam wiederherstellbar, aber getrennt geschützt aufbewahren. Ein Konto-Einmalcode ersetzt den Schutzschlüssel des Servers nicht. Eine kopierte `issuer.enc` ohne den passenden Schutzschlüssel kann nicht geöffnet werden. Beim Verschieben des Datenordners ändert sich die Zuordnung zum nativen Keystore; ein solcher Umzug erfordert eine geplante Schlüsselübertragung.

## Browser-Erweiterung als Seitenstarter

Installation und aktuelle Berechtigungen stehen in der [0.12.0-Installationsanleitung](INSTALLATION.md#6--chrome-und-edge-installieren). Im unteren Bereich **HeavenKey & Zugangslabor öffnen** die lokale Verbindung und den Laborport **18241** einstellen, den gewünschten Laborbereich auswählen und **HeavenKey öffnen** wählen. Passkey-Dialoge und sensible Laborbestätigungen laufen im geöffneten Tab.

**Eigener HTTPS-Dienst** nur für eine selbst eingerichtete Laboradresse mit bekannter Domain wählen. Das ist keine Passwortmanager-Kopplung. Das aktuelle Erweiterungspaket besitzt auch Formularhilfe mit `activeTab`, `scripting`, `storage` und `contextMenus`; es ist nicht mehr die alte Erweiterung ohne Seitenzugriff. Die Formularhilfe mit Masterpasswort koppelt ausschließlich zum lokalen Passwortmanager.

## Wenn etwas nicht klappt

| Problem | Nächster Schritt |
| --- | --- |
| Masterpasswort statt Einrichtungscode sichtbar | Passwortmanager gestartet. Programm direkt ohne `--password-manager` auf Port 18241 starten. |
| `address already in use` | Laufende Instanz verwenden oder einen freien Laborport wählen; Seitenstarter entsprechend einstellen. |
| OS credential store locked/unavailable | Desktop-Schlüsselbund entsperren oder ausdrücklich die externe Schutzdatei konfigurieren. |
| protected file must have permissions 0600 | Unter Unix `chmod 600 /pfad/zur/schutzdatei` und den privaten Ordner prüfen. |
| issuer authentication failed | Ursprünglichen passenden Schutzschlüssel wiederherstellen; ein neuer Schlüssel öffnet vorhandene Daten nicht. |
| Kein Eigentümercode vorhanden | Den lokal ausgegebenen Dateipfad und die bereits erfolgte Eigentümereinrichtung prüfen. Ein Gast registriert sich ohne Code und erhält keine Eigentümerrechte. |
| Passkey abgebrochen / PRF fehlt | Erneut versuchen; für den optionalen Notiztresor ist eine PRF-fähige Kombination erforderlich. Normale WebAuthn-Anmeldung ist davon getrennt. |
| Nach fünf Minuten abgemeldet | Erneut mit Passkey anmelden; der Notiztresor wird dabei ebenfalls gesperrt. |
| Anderes Gerät erreicht localhost nicht | Eigene geprüfte HTTPS-Bereitstellung nötig; siehe [HTTPS-Pilot](HTTPS-PILOT.md). |

Physische Passkeys und diese vollständigen Browserabläufe wurden für die Dokumentationsänderung nicht neu geprüft. Historische Nachweise: [0.7-Prüfbericht](V07-VERIFICATION.md); aktueller Umfang: [Installations-Prüfprotokoll](INSTALLATION-VERIFICATION.md).
