# Herkunft der Bedienillustrationen

Alle SVG-Dateien in diesem Ordner sind **schematische Darstellungen, keine Screenshots**. Das steht auch sichtbar im Bild. Die Grafiken imitieren keinen Nachweis eines tatsächlich ausgeführten Betriebssystem- oder Browserdialogs.

| Dateien | Inhalt / Quellstand |
| --- | --- |
| `01-installation.svg` | Downloadprüfung und Start des Passwortmanagers 0.12.0. |
| `03-chrome.svg`, `04-firefox.svg` | Schematische Browserinstallation für 0.12.0. |
| `08-browserkopplung.svg` | Kopplung, ausdrückliche localhost-Berechtigung und Masterpasswort im Popup, Stand 0.12.0. |
| `09-autofill.svg` | Bewusste Zielseiten- und Feldauswahl mit eigenen Freigaben, Stand 0.12.0. |
| `02-erster-passkey.svg`, `05-zugaenge.svg`, `06-recovery.svg`, `07-agenten.svg` | Historische Laborillustrationen zum Funktionsstand 0.7; nur in der getrennten Labordokumentation verwenden. |

Reproduzieren aus dem Repository-Hauptordner:

```sh
python3 scripts/illustrate_guides.py
```

Die 0.12.0-Beschriftungen wurden gegen `scripts/build_extension.ts`, `apps/extension/popup.html`, `apps/extension/smart-popup.ts` und `apps/web/src/passwords-workflows.ts` im Tag `v0.12.0` abgeglichen. Browserbeschriftungen wurden zusätzlich mit den in der [Installationsanleitung](../INSTALLATION.md) verlinkten offiziellen Browseranleitungen verglichen. Die [PNG-Aufnahmen der tatsächlichen App](../screenshots/README.md) haben eine eigene Herkunftsbeschreibung.
