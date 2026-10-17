# HeavenKey

Passwörter und Formularprofile lokal verwalten. HeavenKey verschlüsselt den Tresor im Browser und speichert ihn auf deinem Computer. Für den Passwortmanager brauchst du weder ein Cloudkonto noch eine Internetverbindung.

[![CI](https://github.com/Supersynergy/HeavenKey/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Supersynergy/HeavenKey/actions/workflows/ci.yml) [![Version 0.11.1](https://img.shields.io/badge/version-0.11.1-b38b3e)](https://github.com/Supersynergy/HeavenKey/releases/latest)

[Downloads](https://github.com/Supersynergy/HeavenKey/releases/latest) · [Einrichtung](docs/DISTRIBUTION.md) · [Bedienung](docs/PASSWORD-MANAGER.md) · [Abnahme](docs/PASSWORD-MANAGER-VERIFICATION.md) · [Lizenz](LICENSE)

![HeavenKey mit Navigation, Eintragsliste und Login-Details im hellen Design](docs/screenshots/vault-desktop.png)

*Die Bilder zeigen die echte lokale App mit ausschließlich erfundenen Beispieldaten. Passwörter bleiben verdeckt.*

## Starten

1. Lade das Paket für deinen Computer aus dem [aktuellen Release](https://github.com/Supersynergy/HeavenKey/releases/latest). Prüfe es mit der dortigen `SHA256SUMS` und entpacke es.
2. Öffne den enthaltenen Starter. Er startet den lokalen Dienst und öffnet `http://localhost:18240/passwords/` im Browser.
3. Lege ein Masterpasswort mit mindestens 14 Zeichen fest. Exportiere anschließend eine verschlüsselte Sicherung und prüfe ihre Wiederherstellung.

| Computer | Paket | Starter |
| --- | --- | --- |
| Windows x64 | `HeavenKey-0.11.1-windows-x64.zip` | `Start HeavenKey.cmd` |
| macOS mit Apple Silicon | `HeavenKey-0.11.1-macos-arm64.zip` | `Start HeavenKey.command` |
| macOS mit Intel-Prozessor | `HeavenKey-0.11.1-macos-x64.zip` | `Start HeavenKey.command` |
| Linux x64 | `HeavenKey-0.11.1-linux-x64.tar.gz` | `./start.sh` |
| Linux ARM64 | `HeavenKey-0.11.1-linux-arm64.tar.gz` | `./start.sh` |

Ein aktueller Browser genügt. Rust, Bun und Docker werden nur für die Entwicklung benötigt. Das Terminal des Starters bleibt geöffnet; `Ctrl+C` beendet den Dienst. Die Pakete sind unsigniert und nicht Apple-notarisiert. [Installation und Datenordner](docs/DISTRIBUTION.md) erklären die Betriebssystemhinweise und den Updateablauf.

## Im Alltag

- **Logins:** anlegen und bearbeiten, nach Titel oder Kontodaten suchen, mit Tags ordnen und als Favoriten markieren. Der Generator erstellt zufällige Passwörter; TOTP-Codes werden lokal berechnet.
- **Schnellzugriff:** F2 öffnet die Suche nach Logins und Formularprofilen. F1 zeigt die Tastenkürzel mit einzelnen Tastenkappen.
- **Formularprofile:** Kontakt- und Adressangaben im selben verschlüsselten Tresor speichern. Die Erweiterung zeigt die erkannten Felder vor dem Ausfüllen zur Auswahl.
- **Importvorschau:** eine CSV lokal einlesen und neue, identische oder abweichende Einträge prüfen. Identische Duplikate werden zunächst übersprungen; einen Konflikt ersetzt du ausdrücklich.
- **Sicherungen:** den verschlüsselten Tresor exportieren und mit seinem Masterpasswort wiederherstellen. Profile bleiben bei Login-Änderungen und Passwortwechseln erhalten.
- **Diskrete Ansicht:** private Detailfelder verdecken; bei Bedarf sofort beim Wechsel in den Hintergrund sperren. Ein lokaler Check zeigt kurze oder wiederverwendete Passwörter, ohne einen Datenleckdienst anzufragen.

### Ausfüllen im Browser

Installiere das separate Chromium-Paket für Chrome oder Edge. Erzeuge unter Einstellungen einen einmaligen Kopplungscode und gib ihn mit dem lokalen Port in der Erweiterung ein. Der Dienst muss laufen. Die [Installationsanleitung](docs/DISTRIBUTION.md#browser-erweiterung) beschreibt auch das temporäre Laden unter Firefox ab Version 140.

Zum Füllen wählst du einen Login oder ein Profil, prüfst die Zielseite und bestätigst die ausgewählten Felder. Logins benötigen genau die gespeicherte Website-Origin. Finanz- und Identitätsdaten sowie Passwörter und Einmalcodes haben eigene Freigaben. Bestehende Werte bleiben standardmäßig erhalten; Formulare werden nicht abgesendet. Rückgängig ist für die unveränderte Zielseite zeitlich begrenzt möglich.

Die Erweiterung hat keinen dauerhaften Zugriff auf alle Websites. Der Browser speichert nur Verbindungseinstellungen und das Kopplungstoken. Sperren, Trennen oder Schließen entfernt die entschlüsselte Sitzung. Eine bereits an die Seite übergebene Eingabe kann diese wie eine manuelle Eingabe lesen.

## Ansichten

![Dunkles Design mit denselben synthetischen Einträgen](docs/screenshots/vault-dark.png)

![CSV-Importvorschau mit einem neuen Eintrag, einem identischen Duplikat und einem Konflikt](docs/screenshots/import-preview.png)

<details>
<summary>Schnellzugriff, Formularprofil und schmale Ansicht</summary>

![F2-Schnellzugriff der echten App](docs/screenshots/quick-access.png)

![Formularprofil mit erfundenen Kontaktangaben](docs/screenshots/form-profile.png)

<img src="docs/screenshots/vault-mobile.png" width="390" alt="Responsive Browseransicht bei 390 Pixeln Breite; keine native mobile App">

![Gesperrter Tresor mit goldenem HeavenKey-Schlüssel](docs/screenshots/vault-locked.png)

</details>

[Herkunft der Bilder](docs/screenshots/README.md)

## Sicherheit und Grenzen

Das Masterpasswort und der nicht exportierbare Schlüssel bleiben im entsperrten Browser. Der Dienst speichert die verschlüsselte Tresorhülle mit AES-256-GCM; die Schlüsselableitung verwendet PBKDF2-HMAC-SHA256 mit 600.000 Iterationen. Revisionen verhindern stilles Überschreiben aus veralteten Tabs. Der lokale Dienst bindet an Loopback und prüft Host, Origin und sein Prozess- beziehungsweise Kopplungstoken. Details stehen in der [Passwortmanager-Anleitung](docs/PASSWORD-MANAGER.md).

Verlust des Masterpassworts lässt sich nicht durch HeavenKey zurücksetzen. JavaScript garantiert keine vollständige physische Speicherlöschung; die Bereinigung der Zwischenablage hängt vom Browser ab. Programme im selben Benutzerkonto und ein kompromittierter Browser gehören zur Vertrauensgrenze.

Die [Release-Abnahme](docs/PASSWORD-MANAGER-VERIFICATION.md) unterscheidet natives Apple Silicon von Rosetta, Wine und QEMU. Die Chromium-Tests verwenden eine ausdrückliche Testfreigabe für localhost; der native Berechtigungsdialog ist nicht automatisiert abgenommen. Firefox wurde auf Paketebene geprüft. Physische Passkeys und ein externes Kryptografie-Audit sind nicht abgenommen. Native mobile Apps, Gerätesynchronisation und die Verwaltung von Website-Passkeys sind noch offen. Die responsive Ansicht ersetzt keinen mobilen Credential-Provider.

`ACCEPTANCE.json` und `SHA256SUMS` im jeweiligen Release binden die Nachweise an Quellstand und Dateien. Der [Vergleich mit Enpass und 20 weiteren Produkten](docs/PASSWORD-MANAGER-GAPS.md) dokumentiert den früheren Ausgangsstand; er ist kein aktuelles Gesamtranking oder Nachweis eines allgemeinen Funktionsvorsprungs.

## Passkey-Zugangslabor

Im selben Produkt ist das getrennte Zugangslabor enthalten: WebAuthn-Anmeldung, mehrere Passkeys und Recovery sowie zeitlich begrenzte Freigaben mit kontrollierter Weitergabe. Dazu kommen ein optionaler PRF-Notiztresor und begrenzte Agentenrechte. Es verwendet eigene Daten und Schutzschlüssel. Der experimentelle Grant-Codec ist kein UCAN-Interoperabilitätsnachweis.

```sh
./heavenkey --password-manager --open
./heavenkey --port 18241 --open
```

Die erste Zeile startet den Passwortmanager, die zweite das Zugangslabor. Unter Windows heißt das Programm `HeavenKey.exe`.

[Passkey-Anleitung](docs/PASSKEY-GUIDE.md) · [Zugänge und Recovery](docs/USAGE.md) · [Agenten](docs/AGENT-GUIDE.md) · [Integration](docs/INTEGRATION.md)

## Entwicklung

Voraussetzungen: Rustup mit dem in `rust-toolchain.toml` festgelegten Toolchain, Bun **1.4.2**, Python 3 und `just`. Browserprüfungen benötigen Chrome oder einen passenden `CHROME_PATH`; native Builds benötigen die jeweiligen Plattformwerkzeuge.

```sh
git clone https://github.com/Supersynergy/HeavenKey.git
cd HeavenKey
bun install --frozen-lockfile --ignore-scripts
cargo fetch --locked
just build
just check
just e2e
```

Der [Startassistent](scripts/first_run.py) baut den Passwortmanager mit `python3 scripts/first_run.py`; `--lab` startet das Zugangslabor. Verwende in Tests ausschließlich synthetische Daten. Das private Repository benötigt eine Zugriffsberechtigung.

[Entwicklung](docs/DEVELOPMENT.md) · [API und Sicherheitsverhalten](docs/SPEC.md) · [Änderungen](CHANGELOG.md) · [Sicherheitsmeldungen](SECURITY.md)

## Lizenz und Rechte

HeavenKey ist proprietäre Software. Die [HeavenKey Proprietary License 1.0](LICENSE) erlaubt berechtigten Empfängern offizieller Binärpakete persönliche und interne Nutzung. Weitervertrieb, öffentliche Forks und abgeleitete Produkte benötigen eine gesonderte Erlaubnis. Drittanbieter-Lizenzen und zwingende gesetzliche Rechte bleiben erhalten.

[Einordnung der Lizenz](docs/LICENSING.md) · [Drittanbieterhinweise](NOTICE.md) · [Beiträge](CONTRIBUTING.md)
