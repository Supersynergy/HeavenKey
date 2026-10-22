# Agenten mit Shellzugriff isolieren

`--broker-sandbox` startet den Agenten in einem separaten Linux-Container. Nur dieser eingeschlossene Prozess gehört zur Schutzgrenze. Ein Agent, der daneben weiterhin eine uneingeschränkte Shell unter deinem Benutzerkonto bedienen darf, kann den Schutz umgehen. Entziehe ihm diesen Zugang, bevor du einen echten Tresor entsperrst.

Der Tresor und der private Anmeldebrowser laufen auf dem vertrauenswürdigen Host. Der eingeschlossene Agent bekommt keine Host-Verzeichnisse, Umgebungsvariablen, Netzwerkverbindung oder Docker-Socket. Ein kleiner Vermittler erlaubt typisierte Login-, Transfer- und geschützte Aufträge. Die gekoppelte Berechtigungsart begrenzt die zulässigen Operationen. Kopplungscode und Clienttoken bleiben beim Vermittler. Jede Anmeldung verlangt weiterhin die Auswahl eines Kontos und deine Zustimmung in HeavenKey.

## Voraussetzungen

- Installiertes Chrome, Chromium oder Edge auf dem Host.
- Ein vertrauenswürdiger lokaler Docker-Dienst mit Linux-Containern. Auf macOS und Windows läuft dieser in einer Linux-VM. Ein entfernter Docker-Dienst gehört nicht zum geprüften Betriebsmodell.
- Ein selbst gebautes, geprüftes Agentenimage mit der statischen Linux-Version von HeavenKey in passender Architektur. Verwende keine fremden Agentenimages mit vertraulichen Dateien.
- Für das beiliegende Bauwerkzeug: Bun und das bereits lokal vorhandene offizielle Image `python:3.13-alpine`. Es lädt keine Images herunter. Fehlt eine Voraussetzung, bricht es ab.

Der normale Passwortmanager benötigt Docker und Bun nicht. Der eingeschlossene Agent kann wegen der Netzwerksperre keinen externen Modelldienst direkt erreichen; ein übergeordnetes Agentensystem muss seine Planung außerhalb dieses Prozesses durchführen und darf dabei keinen freien Host-Shellzugang erhalten.

## Image bauen

Im Quellrepository, mit dem Linux-Releaseprogramm aus derselben Version:

```sh
bun scripts/build_agent_sandbox.ts --binary /absoluter/pfad/linux-arm64/heavenkey --platform linux/arm64 --sha256 ERWARTETER_SHA256
```

Für x64 lautet die Plattform `linux/amd64`. Der Builder prüft ELF-Architektur, statische Verlinkung, Hash und die tatsächlich ausgeführte Versionsausgabe. Er pinnt das lokal vorhandene Python-Basisimage auf dessen Repository-Digest. Sein temporärer Buildkontext enthält nur Dockerfile und HeavenKey-Programm. Notiere die ausgegebene unveränderliche `sha256:…`-Image-ID. Das Image enthält Python; andere Werkzeuge müssen vorab in ein eigenes geprüftes Image eingebaut werden.

## Agenten starten

1. Öffne HeavenKey und entsperre den Tresor. Unter **Einstellungen → Agent-Zugriff** erzeugst du einen einmaligen Kopplungscode.
2. Starte den Vermittler auf dem vertrauenswürdigen Host. Er liest einmalig JSON von stdin: `{"code":"EINMALCODE","label":"Mein eingeschlossener Agent"}`. Übergib es aus einem vertrauenswürdigen Programm im Speicher; verwende keine Zwischenablage, Shellargumente oder dauerhaft gespeicherte Klartextdatei für den Code.
3. Beispielaufruf: `./heavenkey --broker-sandbox 18240 sha256:IMAGE_ID -- python3 -c '…'`. Unter Windows heißt das Hostprogramm `HeavenKey.exe`; das Image enthält weiterhin das Linux-Programm.
4. Der eingeschlossene Prozess bekommt `HEAVENKEY_AGENT_ENDPOINT=http://127.0.0.1:18271`. An diese Adresse sendet er JSON per HTTP POST:

| Pfad | Inhalt |
| --- | --- |
| `/request` | `{"origin":"https://example.com","scope":"login_read"}` |
| `/status` | `{"request_id":"ANFRAGE_UUID"}` |
| `/read` | `{"session_id":"SITZUNGS_UUID","path":"/konto"}` |
| `/close` | `{"session_id":"SITZUNGS_UUID"}` |

Ein über **Geschützte Entwürfe** gekoppelter Agent verwendet stattdessen `/protected/list`, `/protected/login`, `/protected/draft` und `/protected/close` sowie `/status`. Seine Identität darf weder `/request`, `/read` noch Transferoperationen nutzen. Er bekommt keine Seitenansicht. [Composer und lokale Vorschau](PROTECTED-FLOW.md).

Es gibt keinen Token für den Agenten und keinen freien URL-, JavaScript-, Cookie- oder Zwischenablagenzugriff. Prüfe die Anfrage im echten HeavenKey-Fenster und bestätige das gewünschte Konto. Der Agent erhält die gefilterte Textansicht. Die Ausgabe des Agenten wird als `heavenkey_agent_output` verpackt; nur der Vermittler schreibt den abschließenden `heavenkey_sandbox_receipt`. Ein beliebiger Agententext ist kein Sicherheitsnachweis.

Der optionale Entwicklerstart lautet `cargo +nightly-2026-10-11 -Zscript broker.rs /absoluter/pfad/heavenkey --sandbox 18240 sha256:IMAGE_ID -- python3 -c '…'`. Cargo kompiliert und cached dieses kleine Hilfsskript. Es ersetzt weder den Produktbuild noch die Isolation.

## Durchgesetzte Grenzen

Der Host prüft die Konfiguration vor und nach dem Start; der Gast prüft die tatsächlichen Linux-Prozess- und Mountdaten vor dem Agentenstart. Erforderlich sind UID/GID 65532, keine Capabilities, `no-new-privileges`, aktiver Seccomp-Filter, getrennte PID-/Mount-/IPC-/Netzwerk-Namensräume, schreibgeschütztes Root-Dateisystem und privates flüchtiges Arbeitsverzeichnis. Container bekommen höchstens 512 MiB RAM ohne zusätzlichen Swap, zwei CPU-Kerne und 128 Prozesse. Die Laufzeit endet spätestens nach 15 Minuten. Das Arbeitsverzeichnis ist kein dauerhafter Speicher.

Der Vermittler verwaltet ausschließlich seine exakte Container-ID und entfernt sie bei regulärem Ende, Fehler oder behandelbarem Abbruch. SIGKILL, Hostabsturz und ein ausgefallener Docker-Dienst können die Bereinigung verhindern. Die Browserfreigabe läuft unabhängig davon höchstens fünf Minuten. Sperren und Widerruf bleiben jederzeit im Besitzerfenster möglich. Ratenlimits begrenzen gültige Clientoperationen auf 120 pro Minute; nach 32 ungültigen Tokenversuchen innerhalb einer Minute folgen Ablehnungen. Gültige Clients und der Besitzer werden dadurch nicht ausgesperrt.

## Was diese Grenze nicht garantiert

Docker-Dienst, Hostadministrator, Kernel, Besitzerbrowser und Zielwebsite bleiben vertrauenswürdig. Kernel- oder Container-Ausbrüche, ein kompromittierter Host und eine bösartige Zielwebsite sind damit nicht ausgeschlossen. Die Zielwebsite erhält beim Login die Zugangsdaten und kann sie absichtlich anders kodiert zurückgeben; Textfilter sind keine vollständige Vertraulichkeitsgarantie gegen diese Website. Sensible Kontoinhalte können ebenfalls in der freigegebenen Textansicht stehen. Gib nur erforderliche Websites und Konten frei.

Linux-Prozessschutz gegen Core-Dumps und gewöhnliche Ptrace-Zugriffe ist zusätzliche Absicherung. Er ersetzt weder die Agentenisolation noch Datenträgerverschlüsselung und ein externes Audit. Eine Containerprüfung auf macOS oder eine Ausführung unter Wine ist kein Nachweis einer nativen Windows-Abnahme. Die jeweilige Release-Abnahme nennt die tatsächlich ausgeführten Plattformtests.

## Brute Force und weitere Absicherung

Neue Tresore und bewusste Neuverschlüsselungen verwenden Argon2id (64 MiB, drei Durchläufe, eine Lane) und AES-256-GCM. Bestehende PBKDF2-HMAC-SHA256-Tresore mit 600.000 Iterationen bleiben lesbar. Die [KDF-Anleitung](VAULT-KDF.md) erklärt Migration und Sicherungen. Neue offensichtlich triviale oder kurzperiodisch wiederholte Masterpasswörter werden abgewiesen; bestehende Tresore bleiben zum Passwortwechsel zugänglich. Verwende eine lange zufällig erzeugte Passphrase. Online-Ratenlimits verhindern keine Offline-Angriffe auf eine kopierte Tresordatei. KI ändert diese kryptographische Grenze nicht.

Weitere Schritte mit eigenem Abnahmekriterium sind eine kompatible Migration zu einer speicherharten Schlüsselableitung, signierte und unter macOS notarisierte Builds, ein unabhängiges Sicherheitsreview samt Penetrationstest sowie native Windows- und Linux-Desktop-Abnahmen. Ein externer Prüfbericht und eine Herausgebersignatur werden erst nach tatsächlicher Durchführung als Trust-Marker angezeigt. Bis dahin bleibt der entsprechende Hinweis sichtbar.
