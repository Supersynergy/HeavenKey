# HeavenKey betreiben (HTTPS)

Die Vorlagen verbinden einen TLS-Proxy mit der öffentlichen Passkey-Origin der API. HeavenKey bleibt Preview-Software. Ein bestandener Konfigurationscheck belegt weder einen laufenden Server noch echte Touch-ID-/Windows-Hello-Hardware; deren Prüfung bleibt offen (siehe [Prüfstatus](VERIFICATION.md)).

## Aufbau und Identität

```text
Browser -- HTTPS:443 --> Caddy oder nginx -- HTTP/Loopback --> uac-api 127.0.0.1:18240
```

| Datei | Zweck |
| --- | --- |
| `deploy/caddy/Caddyfile` | Caddy-Vorlage mit eigenen TLS-Zertifikaten |
| `deploy/nginx/nginx.conf` | Vollständige nginx-Konfiguration |
| `deploy/systemd/uac-api.service` | API unter einem eigenen Dienstkonto |
| `deploy/systemd/api.env.example` | Öffentliche Identität, privates Dokument und externer Schutzschlüssel |
| `deploy/systemd/uac-gate.service` | Vorlage für das bisherige Gate-Skeleton; nicht aktivieren |
| `scripts/ops_check.py` | Statischer Konfigurationscheck ohne Proxy-Binärdateien |
| `scripts/test_ops_integration.py` | Regressionen für Identität, Timeouts und Schlüsselpfade |

Die Beispiele verwenden die reservierte Domain `lab.example.test`. Für einen lokalen HTTPS-Test muss sie auf den Testserver zeigen und im vertrauenswürdigen Testzertifikat enthalten sein. Für öffentliches Hosting eine eigene DNS-Domain und ein gültiges Zertifikat verwenden.

Diese Werte müssen zusammenpassen:

```ini
HEAVENKEY_PUBLIC_ORIGIN=https://lab.example.test
HEAVENKEY_RP_ID=lab.example.test
HEAVENKEY_DOCUMENT=/etc/heavenkey/private-document.txt
HEAVENKEY_KEY_FILE=/etc/heavenkey/keys/protection.key
UAC_STORE_KEY_FILE=/etc/heavenkey/keys/store.key
```

Die Origin enthält Schema und bei Bedarf den öffentlichen Port, etwa `https://lab.example.test:8443`; die RP-ID enthält ausschließlich den DNS-Namen. Ohne explizite RP-ID verwendet die API den öffentlichen Hostnamen. Bei einem anderen TLS-Port auch den Listener des Proxys anpassen. Die API bleibt auf Loopback-Port 18240. `HEAVENKEY_PUBLIC_ORIGIN` ist die kanonische Konfiguration; `HEAVENKEY_ORIGIN` bleibt als kompatibler Alias unterstützt. Sind beide gesetzt, müssen sie dieselbe Origin bezeichnen, sonst bricht der Start ab. Die RP-ID ist an bestehende Passkeys gebunden; eine Änderung ist keine transparente Migration.

Caddy reicht Host und Origin standardmäßig unverändert durch. nginx setzt `Host $http_host`, damit auch ein öffentlicher Port erhalten bleibt, und reicht Origin unverändert durch. Die API prüft beide Header gegen ihre konfigurierte Identität. Ein Umschreiben auf localhost oder eine erfundene Origin bricht diese Bindung beziehungsweise den CSRF-Schutz.

## Dienst vorbereiten

Die folgenden Befehle sind eine Linux-Anleitung; sie werden vom Konfigurationscheck nicht ausgeführt. Im bereits gebauten Checkout arbeiten und den Dienst erst nach dem Vorbereiten aller Dateien starten.

```sh
sudo useradd --system --home /var/lib/heavenkey --shell /usr/sbin/nologin heavenkey
sudo install -m 0755 target/release/uac-api /usr/local/bin/uac-api
sudo install -d -m 0750 -o root -g heavenkey /etc/heavenkey
sudo install -d -m 0700 -o heavenkey -g heavenkey /etc/heavenkey/keys
sudo install -m 0640 -o root -g heavenkey deploy/systemd/api.env.example /etc/heavenkey/api.env
sudoedit /etc/heavenkey/api.env
```

Ein privates UTF-8-Dokument mit 1 bis 65536 Bytes außerhalb des Webroots bereitstellen:

```sh
sudo install -m 0640 -o root -g heavenkey /pfad/zum/privaten-dokument.txt /etc/heavenkey/private-document.txt
```

Für den Betrieb ohne Desktop benötigt die Vorlage zwei getrennte Schlüsseldateien: `UAC_STORE_KEY_FILE` für die SQLCipher-Datenbank und `HEAVENKEY_KEY_FILE` für den verschlüsselten Issuer-Umschlag. Der Helfer kann beide Dateien erzeugen: jeweils genau 32 zufällige Rohbytes mit Modus 0600, ohne eine vorhandene Datei zu überschreiben.

```sh
sudo python3 scripts/create_protection_key.py /etc/heavenkey/keys/protection.key
sudo python3 scripts/create_protection_key.py /etc/heavenkey/keys/store.key
sudo chown heavenkey:heavenkey /etc/heavenkey/keys/protection.key /etc/heavenkey/keys/store.key
```

Beide Dateien müssen dem Dienstkonto lesbar sein und außerhalb von `/var/lib/heavenkey` liegen. Die Schlüssel einmal anlegen und bei Neustarts behalten. Schlüsselinhalt niemals in ein Log oder ein Repository kopieren. Die API unterstützt alternativ `UAC_STORE_KEY` mit 64 Hexzeichen; dieser Wert hat Vorrang vor `UAC_STORE_KEY_FILE`. Die Vorlage nutzt ausschließlich die Datei, damit kein Schlüsselinhalt in der Dienstumgebung steht. Ohne Datenbankschlüssel-Konfiguration sucht die API ihren Plattformstandardpfad; wegen `ProtectHome` ist dieser für die Unit ungeeignet. Ein fehlender Datenbankschlüssel kann im schreibgeschützten `/etc/heavenkey` nicht automatisch neu angelegt werden; ein falscher Schlüssel verhindert das Öffnen einer bestehenden Datenbank.

Der Issuer-Schutzschlüssel unter `HEAVENKEY_KEY_FILE` wird ebenfalls benötigt. Ein fehlender, falscher oder zu offen lesbarer Issuer-Schutzschlüssel verhindert den Start. Ohne explizite Datei erwartet die API einen verfügbaren nativen Credential Store; sie legt keinen Klartext-Ersatzschlüssel im Datenordner an.

```sh
sudo install -m 0644 deploy/systemd/uac-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uac-api
```

Die Unit lädt `/etc/heavenkey/api.env` verbindlich und startet `uac-api --port 18240 --data-dir /var/lib/heavenkey`. `StateDirectory=heavenkey` legt diesen Datenordner mit Modus 0700 an. `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, eine leere Capability-Menge und `RestrictAddressFamilies=AF_INET AF_UNIX` begrenzen den Prozess. `/etc/heavenkey` ist für den Dienst schreibgeschützt. Eine geänderte Umgebungsdatei oder ein geändertes Dokument wird erst beim API-Neustart eingelesen.

## TLS-Proxy einrichten

Nur einen Proxy einsetzen. Zertifikat und privaten TLS-Schlüssel an den in den Vorlagen angegebenen Pfaden installieren: `/etc/heavenkey/tls/fullchain.pem` und `/etc/heavenkey/tls/privkey.pem`. Den privaten TLS-Schlüssel nur dem Proxy zugänglich machen. Für das lokale Labor kann eine bereits eingerichtete Test-CA verwendet werden, beispielsweise:

```sh
mkcert -cert-file fullchain.pem -key-file privkey.pem lab.example.test
```

Caddy liest den Site-Namen aus seiner eigenen Prozessumgebung:

```sh
HEAVENKEY_DOMAIN=lab.example.test caddy validate --config deploy/caddy/Caddyfile
HEAVENKEY_DOMAIN=lab.example.test caddy run --config deploy/caddy/Caddyfile
```

Bei nginx `server_name` auf denselben Namen setzen. Die Konfigurationsdatei an einem absoluten Pfad installieren, dann vor dem Start prüfen:

```sh
sudo nginx -t -c /etc/nginx/nginx.conf
```

Beide Vorlagen erlauben TLS 1.2/1.3, setzen HSTS und begrenzen Requests auf 64 KiB; die API prüft ihr eigenes Limit von 32 KiB. Die Upstream-Verbindung ist auf fünf Sekunden, die Antwort bei nginx auf 30 Sekunden begrenzt; Caddy setzt 30 Sekunden für Antwortheader und 60 Sekunden für Lesen/Schreiben. nginx deaktiviert Upstream-Retries explizit. Caddy hat keine Retry-Schleife konfiguriert. Die Vorlagen nutzen manuell bereitgestellte Zertifikate; deren Erneuerung und Proxy-Reload bleiben Betreiberaufgaben. Für ACME die Konfiguration anhand der eingesetzten Proxy-Version anpassen und erneut prüfen.

## Daten und Wiederherstellung

| Datei | Inhalt | Schutz |
| --- | --- | --- |
| `/var/lib/heavenkey/uac.sqlite` und gegebenenfalls `-wal`/`-shm` | Konten, öffentliche Passkey-Credentials, Delegationen, Widerrufe und Issuer in `meta` | SQLCipher-verschlüsselt; Dienstverzeichnis 0700 |
| `/var/lib/heavenkey/issuer.enc` | Authentisiert verschlüsselter Issuer-Signierschlüssel | Datei 0600; benötigt den externen Schutzschlüssel |
| `/var/lib/heavenkey/owner-bootstrap.txt` | Einmaliger Einrichtungscode | Datei 0600; nach Einrichtung entfernen |
| `/etc/heavenkey/keys/protection.key` | Externer Schutzschlüssel | 32 Rohbytes, Datei 0600, getrennt vom Datenordner |
| `/etc/heavenkey/keys/store.key` | SQLCipher-Datenbankschlüssel | Andere 32 Rohbytes, Datei 0600, getrennt vom Datenordner |
| `/etc/heavenkey/private-document.txt` | Freigegebenes privates Dokument | Außerhalb des Webroots; Dienst darf lesen |

Die API gleicht den Issuer im verschlüsselten Datenbankeintrag `meta` mit `issuer.enc` ab. Widersprüchliche Issuer brechen den Start ab. Ein bestehender `issuer.key` wird bei erfolgreicher Öffnung migriert und nach der Prüfung entfernt; bestehende Klartext-Datenbanken werden nach SQLCipher migriert. Vor einer Migration eine konsistente Sicherung erstellen. Bei Fehlern die ursprünglichen Dateien erhalten und den Startfehler untersuchen.

Für eine konsistente Sicherung den Dienst stoppen oder ein SQLCipher-kompatibles Backup-Verfahren verwenden. Datenbank und `issuer.enc` zusammen sichern; beide Schlüsseldateien getrennt von diesen Daten und geschützt aufbewahren. Für eine Wiederherstellung dieselben beiden Schlüsselpfade und Schlüssel bereitstellen. Ohne den ursprünglichen Datenbankschlüssel lässt sich die Datenbank nicht öffnen; ohne den Issuer-Schutzschlüssel lässt sich ein vorhandenes `issuer.enc` nicht entschlüsseln. Verlorene Schlüssel lassen sich nicht durch neu erzeugte ersetzen. Restore und Dateirechte in einer isolierten Umgebung prüfen, bevor eine Sicherung als nutzbar gilt.

## Prüfung, Health und Neustart

```sh
python3 scripts/ops_check.py
python3 -m unittest discover -s scripts -p test_ops_integration.py
```

Der statische Check prüft TLS-Direktiven, Loopback-Upstream, unveränderte Browseridentität, Health-Route, Body-Limit, Timeouts größer null bis höchstens 120 Sekunden, systemd-Härtung, die Beispielumgebung, Port-Konsistenz und Klartext-Secrets in `deploy/`. Mit `--json /tmp/heavenkey-ops-check.json` kann ein aktueller Bericht geschrieben werden. Er liest die Vorlagen; installierte Dateien, effektive systemd-Drop-ins, Zertifikatsvertrauen, DNS und laufende Prozesse erfordern separate Prüfungen.

`GET https://lab.example.test/healthz` liefert direkt vom Proxy `200 ok`, selbst wenn die API ausgefallen ist. Es ist nur ein Liveness-Signal des Proxys. `GET https://lab.example.test/health` wird an die API weitergereicht und liefert im HTTPS-Modus `{"status":"ok","mode":"https-passkey-pilot"}`. Erst dieser Aufruf prüft die Erreichbarkeit der API durch den Proxy; er ersetzt keinen Passkey-/Dokumentzugriffstest.

`systemctl restart uac-api` erhält Datenbank, verschlüsselten Issuer und Widerrufe. Laufende Challenges, Sitzungen und Freigaben im Speicher verfallen; Nutzer wiederholen die Anmeldung. systemd sendet beim Stoppen SIGTERM und erzwingt nach 15 Sekunden das Ende. `Restart=on-failure` wartet fünf Sekunden; höchstens drei Starts pro Minute verhindern eine unbegrenzte schnelle Fehlerschleife. Nach einer behobenen Startursache gegebenenfalls `systemctl reset-failed uac-api` ausführen und erneut starten. Logs stehen in `journalctl -u uac-api`; Schlüssel und Bootstrap-Code gehören nicht in Logs.

## Fehlerfälle und offene Abnahme

| Situation | Prüfung und Maßnahme |
| --- | --- |
| `host_denied` (403) | Öffentliche Hostangabe einschließlich Port mit `HEAVENKEY_PUBLIC_ORIGIN` vergleichen; localhost-Rewrites entfernen |
| `origin_denied` (403) | Browser-Origin mit `HEAVENKEY_PUBLIC_ORIGIN` vergleichen; Origin nicht am Proxy ersetzen |
| RP-ID-/Passkey-Fehler | HTTPS-Vertrauen, DNS-Namen und persistierte Identität prüfen; vorhandene Passkeys nicht durch eine ungeplante RP-ID-Änderung entwerten |
| `/healthz` grün, `/health` mit 502/504 | API-Start, Schlüsseldatei, Dokumentpfad und Port-Kollision auf 18240 prüfen |
| API startet nicht | Umgebungsdatei, privates UTF-8-Dokument, beide Schlüsseldateien (je 32 Rohbytes, Modus 0600) und Besitz-/Verzeichnisrechte prüfen; Schlüssel erhalten |
| TLS-Fehler nach Zertifikatswechsel | Vertrauenskette und Hostnamen prüfen, Konfiguration validieren und Proxy neu laden |
| `ops_check.py` meldet FAIL | Report nennt Datei und Erwartung; Vorlage und Regressionen gemeinsam korrigieren |

Nach Installation durch die echte öffentliche Origin anmelden, einen Gast registrieren, das Dokument freigeben, mit dem Gast öffnen und widerrufen. Der nächste Gastabruf muss HTTP 403 liefern. Virtuelle CTAP2-Tests belegen diesen Softwareablauf; echte Hardware, dauerhafte Erreichbarkeit, Restore, Hochverfügbarkeit und Windows-/macOS-Dienstverwaltung benötigen eigene Nachweise. Der Gate-Dienst bleibt ein Skeleton. Das experimentelle Delegationsformat beansprucht keine UCAN-Interoperabilität.
