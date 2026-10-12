# HeavenKey benutzen

HeavenKey verwaltet Passkeys und begrenzte Zugänge zum Demo-Dokument. Die aktuelle Version läuft lokal. Physische Passkeys sind noch nicht abgenommen; `just e2e` verwendet virtuelle Geräte für den vollständigen Testablauf.

## Einrichten

Entpacke ein fertiges Paket und starte es wie in der [Paket-Anleitung](DISTRIBUTION.md) beschrieben. Für einen Start aus dem Quellcode baust du zuerst das Projekt wie in der [README](../README.md#ausprobieren) beschrieben:

```sh
cargo run --locked --offline -p uac-api -- --open
```

Öffne `http://localhost:18240`. Der Server bleibt im Vordergrund; `Ctrl+C` beendet ihn. Die Daten liegen im Benutzerprofil. Der Server zeigt den genauen Pfad an; die [Paket-Anleitung](DISTRIBUTION.md) nennt die Standardorte. Einen vorhandenen Entwicklungsbestand unter `data/` verwendest du mit `--data-dir data`.

Bei einer neuen Installation erzeugt der Server einen einmaligen Einrichtungscode. Öffne die angezeigte Datei `owner-bootstrap.txt` lokal als Textdatei.

Trage den Code bei der Eigentümer-Einschreibung ein und bestätige die Passkey-Erstellung. Damit erhält das Konto die Eigentümerrolle. Gäste wählen einen eigenen Kontonamen statt des vorbelegten `owner` und registrieren sich ohne Einrichtungscode. Nach erfolgreicher Einrichtung kann der Code keine zweite Eigentümerrolle vergeben. Für einen neuen Test benutze einen frischen Datenbestand; ältere Konten werden nicht durch einen neuen Einrichtungscode ersetzt.

## Anmelden und Schlüssel verwalten

Melde dich mit deinem Kontonamen und einem aktiven Passkey an. Die Anmeldung gilt fünf Minuten; danach meldest du dich erneut an. Die Schlüsselübersicht zeigt die hinterlegten Passkeys und ihren Status.

- **Hinzufügen:** Gib dem neuen Schlüssel einen Namen, bestätige die Änderung mit einem vorhandenen Passkey und erstelle den neuen Passkey.
- **Widerrufen:** Wähle den betroffenen Schlüssel, prüfe den Bestätigungsdialog und bestätige mit einem aktiven Passkey. Der Widerruf beendet offene Sitzungen des Kontos.
- **Letzter Schlüssel:** Der letzte aktive Passkey lässt sich nicht widerrufen. Automatische Wiederherstellung nach Verlust aller Schlüssel ist noch nicht verfügbar.

Du kannst bis zu acht aktive Passkeys speichern. Ein anderer aktiver Passkey desselben Kontos kann vorhandene Zugänge weiter nutzen. Um einen Zugang zu entziehen, widerrufe den Zugang selbst.

## Zugang teilen

Der Empfänger braucht zuerst ein registriertes Konto. Wähle den Gast und die gewünschte Laufzeit; erlaubt sind 1–3.600 Sekunden. Beim Delegationsprofil bestimmst du zusätzlich, wie oft der Zugang weitergegeben werden darf: null bis vier weitere Stufen.

Prüfe Empfänger und Grenzen im Bestätigungsdialog. Eine frische Passkey-Bestätigung gibt genau diese Änderung frei. Die Freigabe ist einmalig und gilt 60 Sekunden. Ändern sich die Parameter oder verstreicht die Frist, bestätige erneut.

## Erhaltenen Zugang weitergeben

Öffne als Gast den erhaltenen Delegationszugang. Wähle einen weiteren registrierten Empfänger, dessen Laufzeit und verbleibende Weitergaben. Der neue Zugang muss innerhalb der Elternvorgaben bleiben. Seine Weitergabegrenze muss kleiner sein als die des Elternzugangs.

Ein Zugang ohne verbleibende Weitergaben lässt sich weiterhin nutzen, aber nicht weitergeben. Eine Kette besteht aus höchstens fünf Gliedern. Die älteren direkten Zugänge unterstützen keine Weitergabe.

## Nutzen und widerrufen

Ein Gast öffnet das Demo-Dokument über einen aktiven Zugang und bestätigt den konkreten Aufruf mit einem Passkey. HeavenKey prüft Identität, Rechte, Ablauf und die aktuelle Widerrufslage vor der Ausführung.

Der Eigentümer oder das tatsächlich ausstellende Konto kann einen Delegationszugang widerrufen. Der Widerruf sperrt auch die davon abhängigen Nachfolger und offene Aufrufe. Ein Neustart stellt den Zugang nicht wieder her. Getrennte, weiterhin gültige Zugänge bleiben eigenständig nutzbar.

## Wenn etwas nicht klappt

| Situation | Nächster Schritt |
| --- | --- |
| Passkey-Dialog abgebrochen | Starte die gewünschte Aktion erneut. |
| Freigabe abgelaufen | Prüfe die Angaben und bestätige erneut mit einem Passkey. |
| Zugang abgelaufen oder widerrufen | Bitte das ausstellende Konto um einen neuen Zugang. |
| Weitergabe abgewiesen | Prüfe Elternlaufzeit, verbleibende Weitergaben und Empfängerkonto. |
| Nach Neustart abgemeldet | Melde dich erneut an; gespeicherte Schlüssel und Widerrufe bleiben erhalten. |
| Chrome wird beim Test nicht gefunden | Setze `CHROME_PATH` auf die ausführbare Chrome-Datei. |

Die Datenbank ist derzeit kein verschlüsselter Tresor. Die API und ihr Signierschlüssel müssen vertrauenswürdig bleiben. Eine Passkey-Bestätigung bietet keine unabhängige Anzeige der Transaktionsdaten auf dem Authentikator. Weitere technische Grenzen stehen in der [Spezifikation](SPEC.md).
