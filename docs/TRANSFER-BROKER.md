# SFTP- und FTPES-Zugänge mit HeavenKey

HeavenKey verwaltet Transferprofile im verschlüsselten lokalen Tresor. Ein gekoppelter Agent stellt eine Anfrage für genau eine Verbindung, Operation und Datei. Der Besitzer bestätigt sie in der App. Der vertrauenswürdige lokale Transferdienst meldet sich beim Server an; der Agent erhält weder das Passwort noch den privaten Schlüssel. Die Zwischenablage wird dafür nicht verwendet.

## Verbindung einrichten

Öffne **Einstellungen → Dateitransfer → Verbindung hinzufügen**. Wähle den Anbieter oder „Eigener Server“. Übernimm Host, Port und Benutzer aus deinem Anbieterkonto. Anbieterprofile sind Einrichtungshilfen; sie enthalten keine tatsächlichen Zugangsdaten und bestätigen keine Verbindung.

Verwende einen eigenen Transferbenutzer, dessen **serverseitige Kontogrenze** genau den vorgesehenen Ordner umfasst. Das Stammverzeichnis in HeavenKey ist `/`, also die gesamte sichtbare Wurzel dieses Kontos. FTP-Metadaten können Symlinks wie normale Dateien melden; portable SFTP-Pfadprüfungen verhindern keine Rennen mit anderen Remote-Schreibern. Deshalb ersetzt die App keine serverseitige Ordnersperre. Andere Benutzer dürfen diese Grenze nicht verändern. HeavenKey kann die Serverkonfiguration nicht unabhängig beweisen.

Für SFTP: Vergleiche den SHA256-Hostfingerabdruck über einen unabhängigen Kanal. Erzeuge ein Ed25519-Schlüsselpaar im Besitzerbrowser und hinterlege ausschließlich dessen öffentlichen Schlüssel beim Anbieter. Der private PKCS8-Schlüssel bleibt im verschlüsselten Tresor. Alternativ kann ein SFTP-Passwort im Besitzerdialog gespeichert werden. Die App verwendet keinen allgemeinen SSH-Agent-Socket und übernimmt keine ausführbare SSH-Konfiguration.

Für FTPES: Verwende explizites TLS mit überprüftem Servernamen und verschlüsseltem Kontroll- und Datenkanal. Klartext-FTP und ein Rückfall darauf sind ausgeschlossen. Bei privaten Servern kann der Besitzer eine öffentliche CA im erweiterten Dialog hinterlegen. Das erweitert das Vertrauen für diesen Verbindungsaufbau; es deaktiviert weder Ketten- noch Hostnamenprüfung. Eine eingetragene CA ist noch kein erfolgreicher Verbindungstest.

## Agent verwenden

Kopple den Agenten unter **Agent-Zugriff**. Die Verbindungs-ID steht am gespeicherten Transferprofil. Jeder Auftrag benötigt eine neue Besitzerfreigabe. Die CLI nimmt die eingeschränkte Agentenberechtigung über stdin entgegen; Passwörter und private Schlüssel gehören weder in Befehlsargumente noch in Umgebungsvariablen.

```json
{"token":"EINGESCHRAENKTE-AGENTENBERECHTIGUNG","connection_id":"PROFIL-UUID","operation":"list","path":""}
```

Übergib dieses JSON per stdin an `heavenkey --broker-agent PORT transfer-request`. Die Antwort enthält eine `request_id`. Für den Status verwende `transfer-status` mit `token` und `request_id`. Der Broker liefert Dateiinhalte erst nach einer ausdrücklichen Downloadfreigabe. Auch Verzeichnis- und Dateimetadaten können vertraulich sein.

Agenten mit Shell müssen mit `--broker-sandbox` ohne zusätzlichen Hostzugriff laufen. Im eingeschlossenen Agenten stehen `/transfer/request` und `/transfer/status` am bereits vorhandenen lokalen Broker-Endpunkt bereit. Der Container bekommt keinen direkten Serverzugriff, keine Tresordateien, keine Clientberechtigung und keinen SSH-Socket. Direkte CLI-Nutzung außerhalb dieser Isolation bietet diese OS-Grenze nicht.

Unterstützt sind `list`, `stat`, `get` und `put`, relative Pfade ohne Punktsegmente, maximal 1 MiB je Datei, 200 Verzeichniseinträge und fünf Minuten je Anfrage. Uploads enthalten Base64url-Inhalt und dessen SHA256. Der Besitzer bestätigt den Hash und Zielpfad. SFTP verweigert derzeit das Ersetzen bestehender Dateien; FTPES lädt über STOU zunächst eine eindeutige temporäre Datei und führt nach erneuter Autorisierung RNTO aus. Das Ersetzen eines FTPES-Ziels ist ausdrücklich Teil der Freigabe. Eine universelle atomare No-Replace-Garantie für FTP wird nicht behauptet. Bei Abbruch können auf einem nicht mehr erreichbaren Server temporäre Dateien verbleiben.

Sperren, Profiländerungen, Ablauf und Widerruf verhindern weitere Nutzung. Bereits gelesene Daten oder abgeschlossene Schreibvorgänge lassen sich damit nicht zurückholen. Für eine Schlüsselrotation: neues Paar erzeugen, öffentlichen Schlüssel hinzufügen, Anmeldung prüfen und den alten Schlüssel beim Server entfernen. Entfernen eines lokalen Profils allein entfernt keinen Server-Schlüssel.

## Zehn Programme

Die Auswahl ist keine Marktanteilsrangliste. Die App unterscheidet native Konfigurationsdateien von einer manuellen Übergabe der Verbindungsdaten. Externe Programme bekommen keine HeavenKey-Freigabe und keine automatischen Zugangsdaten. Ihre eigene Anmeldung, Speicherung und Serverprüfung liegen außerhalb des Brokers.

| Programm | Plattform | Übergabe |
|---|---|---|
| FileZilla | macOS, Linux, Windows | XML-Importvorschau; Export ohne Passwort oder privaten Schlüssel |
| Cyberduck / duck | macOS, Windows; duck auch Linux | `.duck`-Lesezeichen ohne Geheimnisse |
| FreeSCP | macOS, Linux, Windows | Verbindungsdaten als JSON, separate Einrichtung |
| OpenSSH sftp | macOS, Linux, Windows mit OpenSSH | Eigene Konfiguration, strikte Hostprüfung, kein Agent-Forwarding |
| rclone | macOS, Linux, Windows | Konfiguration mit verpflichtender SSH-/TLS-Prüfung |
| lftp | macOS, Linux | Konfiguration mit verpflichtender SSH-/TLS-Prüfung |
| WinSCP | Windows | Verbindungsdaten als JSON, separate Einrichtung |
| Transmit | macOS | Verbindungsdaten für „Add New Server“ |
| ForkLift | macOS | Verbindungsdaten für einen Favoriten |
| Commander One | macOS | Verbindungsdaten für den Connections Manager |

Die Konfigurationsdateien wurden als Exporte geprüft. Dies ist keine Behauptung nativer Laufzeitabnahme aller zehn Drittprogramme. Ausführbare Zeichenfolgen werden nicht automatisch gestartet. Die App und der Agent lesen keine bestehenden Schlüsseldateien oder gespeicherten Passwörter dieser Programme aus.

## Zehn Anbieterprofile

| Anbieter | Vorgabe | Zu prüfen |
|---|---|---|
| netcup Webhosting | FTPES 21 | Zusätzlichen FTP-Benutzer auf Zielordner begrenzen. SFTP-Hauptbenutzer hat wesentlich mehr Rechte. |
| Hetzner Storage Box | SFTP 22 | Unteraccount und externe Erreichbarkeit |
| IONOS Webhosting | SFTP 22 | Produktabhängige Zugangsart; explizites FTPES 21 ebenfalls möglich |
| STRATO | SFTP 22 | Persönlichen Host und geeigneten Zugang im Kundenkonto |
| ALL-INKL.COM | FTPES 21 | SFTP hängt vom Tarif ab; Rechte im KAS |
| Hostinger | SFTP 65002 | Tatsächliche Werte und SSH-Freischaltung im hPanel |
| SiteGround | SFTP 18765 | Host, Benutzer und öffentlichen Schlüssel in Site Tools |
| DreamHost | SFTP 22 | Eigenen SFTP-Benutzer und Website-Zuordnung |
| Bluehost | SFTP 22 | SSH-Freischaltung und passenden Systembenutzer |
| OVHcloud | SFTP 22 | SFTP-Aktivierung und Kontorechte |

Quellen und Stand sind im auslieferbaren [Katalog](../packages/transfers/catalog.ts) hinterlegt: offizielle Anbieter- und Programmdokumentation, geprüft am 22. Oktober 2026. Tarif und konkrete Serverwerte müssen vor Ort bestätigt werden; diese Veröffentlichung führt keine echten Hosting-Kundenkonten als getestet auf.

## Vertrauensgrenzen und Tests

Host, Administrator, Besitzerbrowser und Zielserver bleiben vertrauenswürdig. Ein Agent mit zusätzlichem uneingeschränktem Hostzugriff kann die vorgesehene Isolation umgehen. Eine fremde CA darf nur nach bewusster Prüfung eingetragen werden. Serverbetreiber können Dateien und Metadaten verändern; heruntergeladene Inhalte sind untrusted und dürfen keine neuen Agentenrechte erteilen.

Die Releaseabnahme bindet enge Rust-/TypeScript-Tests, echte lokale SFTP-/FTPES-Server und die Browserreise an Quell- und Binärhashes. Plattform, Umfang und offene Grenzen stehen in `ACCEPTANCE.json`. Virtuelle oder Container-Tests ersetzen weder ein externes Sicherheitsaudit noch Tests mit deinen tatsächlichen Hosting-Konten.
