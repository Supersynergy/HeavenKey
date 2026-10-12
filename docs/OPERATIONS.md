# HeavenKey betreiben (HTTPS)

Dieser Leitfaden beschreibt den Betriebs-Layer für HeavenKey außerhalb der lokalen Demo: TLS-Terminierung vor `uac-api`, Dienstverwaltung per systemd und die statische Prüfung der Konfiguration. Es ist weiterhin Labor- und Preview-Software (Version 0.6) — kein Produktivbetrieb, kein HA-Setup. Physische Passkey-Prüfung bleibt offen (siehe [Prüfstatus](VERIFICATION.md)).

## Aufbau

```
Browser --(HTTPS, Port 443)--> Caddy oder nginx --(HTTP, Loopback)--> uac-api 127.0.0.1:18240 --> data/
```

| Datei | Zweck |
| --- | --- |
| `deploy/caddy/Caddyfile` | TLS-Terminierung mit Caddy (Vorlage) |
| `deploy/nginx/nginx.conf` | TLS-Terminierung mit nginx (vollständige Konfiguration) |
| `deploy/systemd/uac-api.service` | systemd-Unit für die API mit Härtung |
| `deploy/systemd/uac-gate.service` | Beispiel-Unit für das künftige `uac-gate` (Skeleton) |
| `scripts/ops_check.py` | Statische Prüfung aller Dateien ohne installierte Proxys |
| `docs/evidence/ops-check.json` | Zuletzt erzeugter Prüfbericht |

Du brauchst nur einen der beiden Proxys. Beide Vorlagen setzen TLS 1.2/1.3 ohne schwache Cipher, eine statische Health-Route `/healthz` (Antwort ohne die API, für Monitoring), Timeouts und ein Body-Limit von 64 KiB — bewusst oberhalb des API-Limits von 32 KiB (`DefaultBodyLimit`), damit die API ihre eigene Fehlermeldung liefern kann.

## Einrichten (Labor)

1. **Zertifikat erzeugen.** Mit [mkcert](https://github.com/FiloSottile/mkcert):

   ```sh
   mkcert -install
   mkcert -cert-file fullchain.pem -key-file privkey.pem localhost 127.0.0.1
   sudo install -D -m 0644 fullchain.pem /etc/heavenkey/tls/fullchain.pem
   sudo install -D -m 0600 privkey.pem /etc/heavenkey/tls/privkey.pem
   ```

   Alternativ ein selbstsigniertes Zertifikat: `openssl req -x509 -newkey rsa:2048 -nodes -keyout privkey.pem -out fullchain.pem -days 90 -subj "/CN=localhost"`. Self-signed erzeugt Browserwarnungen; mkcert ist für das Labor bequemer.

   **Let's Encrypt (Skizze):** Für eine echte Domain bei Caddy die `tls`-Zeile durch `email admin@example.com` im Globalblock und den Domainnamen als Site-Adresse ersetzen — Caddy holt und erneuert die Zertifikate dann selbst per ACME. Bei nginx `certbot --nginx -d lab.example.test` oder `certbot certonly` mit anschließender Pfadanpassung; Erneuerung läuft über den certbot-Timer. Öffentliche Zertifikate erfordern eine öffentlich erreichbare Domain auf Port 80/443.

2. **Proxy installieren.**

   - Caddy: `HEAVENKEY_DOMAIN=localhost caddy run --config deploy/caddy/Caddyfile` (Site-Adresse kommt aus der Umgebung, Standard `localhost`).
   - nginx: `sudo nginx -t -c deploy/nginx/nginx.conf` und dann `sudo nginx -c deploy/nginx/nginx.conf`, oder den `http`-Block in die Systemkonfiguration übernehmen. Die Vorlage nutzt `listen 443 ssl http2;` (ab nginx 1.25 heißt die moderne Schreibweise `http2 on;` in eigener Zeile).

3. **systemd-Unit installieren.**

   ```sh
   sudo useradd --system --home /var/lib/heavenkey --shell /usr/sbin/nologin heavenkey
   sudo install -m 0755 target/release/uac-api /usr/local/bin/uac-api
   sudo install -m 0644 deploy/systemd/uac-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now uac-api
   ```

   Die Unit startet `uac-api --port 18240 --data-dir /var/lib/heavenkey`. `StateDirectory=heavenkey` legt `/var/lib/heavenkey` mit Modus 0700 an; `ProtectSystem=strict` macht den Rest des Dateisystems schreibgeschützt, `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies=AF_INET AF_UNIX` und eine leere Capability-Menge begrenzen den Prozess. `Restart=on-failure` mit `RestartSec=5s` startet nach Abstürzen neu.

   `uac-gate.service` ist eine Vorlage für den künftigen Gate-Dienst (aktuell Skeleton in `apps/gate/`); `ExecStart` ist an die fertige Implementierung anzupassen.

4. **Konfiguration prüfen.**

   ```sh
   python3 scripts/ops_check.py --json docs/evidence/ops-check.json
   ```

   Der Check läuft ohne installierte Proxy-Binärdateien: Er prüft Pflichtdirektiven (TLS-Versionen, Cipher, Upstream `127.0.0.1:18240`, Host-Rewrite, Health-Route, Body-Limit ≥ 32 KiB, HSTS, Timeouts), die systemd-Härtung, Klartext-Secrets und die Port-Konsistenz. Exit-Code 0 = sauber, 1 = Fehler.

## Datenordner `data/`

Die API schreibt in ihr Datenverzeichnis (`--data-dir`, Standard `~/.local/share/HeavenKey`, in der Unit `/var/lib/heavenkey`):

| Datei | Inhalt | Schutz |
| --- | --- | --- |
| `uac.sqlite` | Konten, Credentials, Delegationen, Widerrufe | unverschlüsselt; Verzeichnis 0700 |
| `issuer.key` | Ed25519-Signierschlüssel (32 Bytes) | Datei 0600; niemals sichern/committen |
| `owner-bootstrap.txt` | Einmaliger Einrichtungscode | Datei 0600; nach Einrichtung entfernen |

Das Verzeichnis gehört ausschließlich dem Dienstkonto. `data/` ist in `.gitignore` eingetragen; diese Dateien gehören niemals in ein Repository, Log oder Ticket.

## Protokoll und Neustart

- **Logs:** Die API schreibt Startmeldungen (Port, Datenpfad, Hinweis auf `owner-bootstrap.txt`) auf stdout — unter systemd via `journalctl -u uac-api`. Secrets werden nicht geloggt; der Einrichtungscode erscheint nur als Dateipfad.
- **Health:** `GET https://<host>/healthz` antwortet der Proxy selbst (`200 ok`); `GET /health` geht an die API und liefert `{"status":"ok","mode":"simulation-lab"}`.
- **Restart:** `systemctl restart uac-api`. Persistenz (SQLite, Issuer-Key, Widerrufe) bleibt; im Speicher gehaltene Challenges und Freigaben verfallen — Nutzer melden sich erneut an bzw. wiederholen die Aktion. Graceful Shutdown läuft über `TimeoutStopSec=15s` (SIGTERM → Ctrl+C-Pfad der API).
- **Reihenfolge:** Proxy kann vor der API laufen; `/healthz` bleibt erreichbar, `/health` und alles andere liefern 502/504, bis die API wieder bindet.

## Fehlerfälle

| Situation | Verhalten | Maßnahme |
| --- | --- | --- |
| Zertifikat läuft ab | Browserwarnung/TLS-Fehler; `journalctl` des Proxys meldet das Ablaufdatum | Bei Caddy+ACME automatisch; sonst Zertifikat erneuern und `caddy reload`/`nginx -s reload` (kein Dienstneustart nötig) |
| Cert-Rotation ohne Reload | Proxy bedient weiter das alte Zertifikat aus dem Speicher | Reload senden; systemd: `systemctl reload caddy`/`nginx` |
| Port-Kollision auf 443 oder 18240 | Dienst startet nicht; `journalctl` zeigt `address already in use`, `ss -ltnp` nennt den Inhaber | Anderen Dienst umziehen; API-Port nur mit passendem Proxy-Upstream ändern |
| API down / noch nicht gebunden | Proxy liefert 502/504, `/healthz` antwortet trotzdem 200 | `systemctl status uac-api`, `journalctl -u uac-api -b`; Unit startet per `Restart=on-failure` selbst neu |
| `host_denied` (403) | Host-Header ≠ `localhost:18240` | Direktaufruf ohne Proxy-Rewrite oder verändertes `header_up`/`proxy_set_header`; Template wiederherstellen |
| `origin_denied` (403) | POST ohne `Origin: http://localhost:18240` | Siehe „Bekannte Grenzen“ — Browser-POSTs hinter HTTPS sind derzeit nicht nutzbar |
| `ops_check.py` meldet FAIL | Direktive fehlt/abweichend oder Port inkonsistent | Zeile im Report zeigt Datei und Erwartung; siehe `docs/evidence/ops-check.json` |

## Bekannte Grenzen und TODOs

- **Origin-/Host-Pinning der API:** `origin_guard` in `apps/api/src/main.rs` erzwingt `Host: localhost:18240` exakt und verlangt bei nicht-GET-Anfragen `Origin: http://localhost:18240`; der WebAuthn-RP ist fest `localhost`. Die Templates schreiben deshalb `Host` um, lassen `Origin` aber unangetastet (die Prüfung ist CSRF-Schutz). **Folge:** Der HTTPS-Endpunkt dient derzeit Health-Checks, statischen GETs und Betriebsnachweis; Passkey-Zeremonien und alle Browser-POSTs hinter einer anderen Origin schlagen fehl. **TODO (API-Änderung, anderer Workstream):** öffentliche Origin/Host/RP-ID konfigurierbar machen (z. B. `--public-origin`), idealerweise zusammen mit `uac-gate`.
- **Einbindung in den Check-Ablauf:** `ops_check.py` ist bewusst noch nicht in `scripts/ci.sh` verdrahtet (parallele Arbeit an `ci.sh`). Einbinden würde man es als eine Zeile `python3 scripts/ops_check.py --json docs/evidence/ops-check.json` in `source_checks()` — es ist dependency-frei und offline lauffähig.
- **Nicht abgedeckt:** physische Passkey-/Hardware-Prüfung (deferred), Hochverfügbarkeit/Clustering, Rate-Limiting/WAF, zentrale Log-Sammlung, Backups des Datenordners, Secrets-Management über Dateirechte hinaus, Windows/macOS-Dienstverwaltung (nur systemd/Linux).
- **Wire-Format:** Das Delegations-Format bleibt experimentell; der Betriebs-Layer ändert daran nichts und beansprucht keine UCAN-Interoperabilität.
