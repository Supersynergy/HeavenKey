# Android Wallet für Mitgliedschaften und Freigaben

Die Vorschau weist eine synthetische Mitgliedschaft nach, öffnet einen einzelnen Test-Projektbereich und erlaubt anschließend einen Rechnungsentwurf zu einem bestimmten Testauftrag. Der Ablauf verwendet den Systembrowser und die vorhandene Android-App. Der Aussteller, Verifier und die Fachanwendung starten gemeinsam im lokalen Testdienst. Ein Office-Testmandant kann den unter [Integrationsvertrag](#integrationsvertrag-für-office) beschriebenen Ablauf übernehmen.

## Priorität und Abnahme

| Rang | Engpass | Entscheidung | Abnahme |
| --- | --- | --- | --- |
| 1 | Einen verifizierbaren Geschäftsvorgang auswählen | Mitgliedschaft → Projektzugang → Entwurf zu einem Zusatzauftrag | Die angemeldete Testsitzung öffnet genau ein Projekt und erhält genau eine Entwurfsreferenz. |
| 2 | Vertrauen und Fehlbedienung | Geprüfter Empfänger, Anzeige der tatsächlich offenbarten Daten, aktuelle Gerätebestätigung und definierte Operation | Geänderte Anfrage, veraltete Bestätigung, fremde Sitzung und Rechteentzug stoppen die Wirkung. |
| 3 | Wiederholung und Wiederaufnahme | Serverseitige Belege, Einmalverbrauch, Widerruf und Idempotenz | Mehrfachaufruf erzeugt höchstens einen Entwurf. Ein unbekannter Transportausgang lässt sich abgleichen. |
| 4 | Integration mit geringem Aufwand | Bestehende Android-App, Browser und Authentifizierung ergänzen. Für den Übergang ein festes, dokumentiertes Protokollprofil einsetzen. | Abnahme mit einer unabhängig implementierten Gegenstelle und auf einem Gerät getrennt protokollieren. |

Für einen bezahlten Supersynergy-Pilot bleibt der kaufbare Nutzen der nachvollziehbare, abrechnungsfähige Nachtrag. Gemessen werden je bestätigtem Vorgang Zeit vom Zusatzwunsch bis zum geprüften Entwurf, manuelle Bearbeitungszeit, Korrekturen und bestätigter Betrag. Die synthetische Vorschau misst technische Abnahme. Kundennutzen und Zahlungsbereitschaft werden im begleiteten Pilot ermittelt.

## Bestandsaufnahme

Die Wallet-Entwicklung begann bei `c701545` (Quellversion 0.30.0). Die gemeinsame 0.32-Vorschau übernimmt auch die bereits veröffentlichte `v0.31.0-preview.7`. Die Server- und Desktop-Dienste verwenden Rust und eine TypeScript-Weboberfläche. Desktop öffnet WebKit oder den Systembrowser. Die Chromium-/Firefox-Erweiterung hat eigene PRF-/Autofill-Grenzen. Android nutzt Flutter, Kotlin, Android Keystore, Website-Passkeys, optionale Desktop-Kopplung und portable Passwort-Tresorsicherungen. iOS besitzt einen eigenen nativen Tresorpfad. Der getrennte OIDC-Pilot ist für Kontoanmeldung zuständig.

| Anforderung | Vorhandener Baustein und belegte Grenze | Änderung | Abnahme |
| --- | --- | --- | --- |
| Nachweise sicher empfangen | Android-Tresor ist auf Logins, Profile, App-Bindungen und Website-Passkeys ausgelegt. | Eigene native Credential-Ablage und eigene Holder-Keys. | Original bleibt nativ, separate Schlüssel und Neuausstellung. |
| Präsentation | OIDC-Pilot und Passkeys authentifizieren bestehende Konten. | OID4VCI/OID4VP als separater Vorgang hinter Android-Fassade. | Aussteller, Audience, Nonce, Offenlegung, Holder-Bindung und Status prüfen. |
| Sitzung und Fachrecht | Webkonten und Mandantenrechte haben bereits eigene Regeln. | Verifier bindet das Ergebnis an die anfragende Sitzung. | Ausschließlich Projektzugang für die gebundene Sitzung. |
| Freigabe und Agent | Bestehende Browser- und Labor-Grants sind für Zugangsdaten und andere Ressourcen ausgelegt. | Unveränderlicher Vorschauplan und zielseitiger Einmalauftrag. | Agent erhält Referenzen und einen minimierten Ergebnisbeleg. |
| App-Wechsel und Recovery | Android sperrt den Tresor bei `onStop()`. Passwort-/Website-Passkey-Backups besitzen eigene Formate. | Wallet-Lifecycle und Persistenz getrennt von aktiver Freigabe halten. | Hintergrundwechsel fordert neue Bestätigung. Geräteverlust führt zur Neuausstellung. |
| AYA | Das Ökosystemprofil ist eine optionale Organisationssicht. | Lokale Einstellung und vertrauenswürdige Profilkonfiguration getrennt behandeln. | Anzeigeoption verändert keine Schlüssel, Aussteller oder fachlichen Rechte. |

Website-Passkeys, ihr Backup und die vorhandenen Login-/Autofill-Brücken bleiben in ihren bestehenden Datenpfaden. Der Login-Pilot, die produktive Publikation und die Android-Signierung behalten ihre vorhandenen Gates.

## Protokollprofil

- OpenID4VCI 1.0 Final, Vorautorisierung für synthetische Testangebote, ein kurzlebiger Code und nonce-gebundener ES256-Holder-Proof. Credential-Konfiguration `membership` mit Format `dc+sd-jwt` und Typ `https://heavenkey.app/credentials/membership/v1`.
- OpenID4VP 1.0 Final mit vorregistriertem Client `heavenkey-membership-verifier`, signierter Anfrage via `request_uri`, DCQL und `direct_post` über TLS. Ergebnisabgleich über die gebundene Anwendungssitzung und einen vorgangsspezifischen Abruf.
- Beim Rechnungsentwurf enthält die signierte Anfrage zusätzlich `transaction_data`. Die Wallet zeigt den typisierten Auftrag und bindet den Hash der Originalkodierung im Holder-Proof. Eine reine Attributfreigabe kann keine Agentenaktion autorisieren.
- ES256, P-256 und SHA-256. Separate konfigurierte Aussteller- und Prüferanker. Die Holder-Bindung folgt aus `cnf.jwk` und KB-JWT mit `aud`, `nonce`, `iat` und `sd_hash`. Die zu präsentierenden Attribute sind `org_id` und `membership`. Die Freigabeansicht zeigt den Empfänger, beide Werte und das Ziel der Anfrage.
- Token Status List mit Signatur des Ausstellers. Die Vorschau verlangt eine aktuelle Onlineprüfung und schlägt bei unbekanntem Status fehl. Die HTTP-Antwort hat `Cache-Control: no-store`, der signierte Status läuft nach 60 Sekunden ab und enthält `ttl: 1`. Im lokalen Dienst wird der maßgebliche Status vor Prüfung und Ausführung direkt in SQLite gelesen. Die Credentials sind eine Stunde gültig, Projektzugang fünf Minuten und die Browsersitzung 15 Minuten. Anfragen gelten bis zu zwei Minuten, die zulässige Uhrtoleranz beträgt fünf Sekunden.
- Die Testeinrichtung hält Ursprung und Pfade eng begrenzt. Wallet-Profile werden für Android explizit in der separaten Vorschau konfiguriert. Die Rollen werden im lokalen Dienst getrennt behandelt. Für die Testausstellung werden ausschließlich synthetische Angaben verwendet.
- Das Profil verwendet eine bewusst enge Teilmenge. HAIP fordert unter anderem `direct_post.jwt`. EUDI Wallet Core bringt zusätzliche Formate, Proximity und Secure-Area-Integration mit. Der erste Ablauf verwendet die bestehenden Android-Schutzgrenzen mit gezielten Bibliotheken. walt.id Community Stack und OpenWallet Foundation Credo sind Gegenstellenkandidaten. Für mdoc und HAIP ist ein eigenes erweitertes Profil mit End-to-End-Konformitätsnachweis erforderlich.

Primärquellen: [OpenID4VCI](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0-final.html), [OpenID4VP](https://openid.net/specs/openid-4-verifiable-presentations-1_0-final.html), [HAIP](https://openid.net/specs/openid4vc-high-assurance-interoperability-profile-1_0-final.html), [RFC 9901](https://www.rfc-editor.org/rfc/rfc9901.html), [SD-JWT VC](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/), [Token Status List](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-status-list-21), [EUDI Android Wallet Core](https://docs.eudi.dev/latest/build/build-your-wallet/android/library-level/), [walt.id](https://github.com/walt-id/waltid-identity/releases), [Credo](https://github.com/openwallet-foundation/credo-ts), [OpenID-Konformitätsprüfung](https://openid.net/certification/).

## Integrationsvertrag für Office

| Schritt | Verantwortung | Bindung und Ergebnis |
| --- | --- | --- |
| Start | Office prüft das bestehende Konto, Mandant und Projekt und erstellt einen kurzlebigen Vorgang. | Serverseitige Referenzen auf anfragende Sitzung, Mandant und Ressource. Kein fremder Mandant aus Wallet-Eingaben. |
| Prüfung | Der Verifier nimmt die Präsentation auf der festgelegten Rückadresse an und validiert das konfigurierte Profil. | Ergebnis für genau diesen Vorgang und die zu Beginn gebundene Sitzung. Mindestens Prüfer, Nachweistyp, geprüfte Attribute, Prüfzeit und Ablauf. |
| Projekt | Die Office-Policy bildet die geprüfte Organisationszugehörigkeit auf genau die definierte lokale Projektberechtigung ab. | Attributwerte sind Eingaben der Zielpolicy. Office-Konto, organisationsbezogene Referenz und Credential-Status bleiben getrennt. |
| Auftrag | Office bestimmt mit aktuellen Daten den Auftrag und den konkreten EUR-Entwurf und erstellt eine kurze Einmalfreigabe. | Feste Zieladresse, Mandant, Auftrag, Agent, Aktion, Zweck, Betrag, Gültigkeit sowie freigegebener Positions- und Preissnapshot. Abweichungen erzeugen einen neuen Freigabeplan. |
| Ausführung | Office authentifiziert die Maschinenidentität separat und prüft aktuelle Benutzer-, Organisations-, Auftrags- und Agentenrechte. | Atomarer Verbrauch, Idempotenzschlüssel und bestehende validierte Rechnungsentwurf-Aktion. Der Adapter übergibt serverseitig gebundene Parameter ohne Versand, Erinnerung, Zahlung oder Finalisierung. |
| Ergebnis | Office gibt einen minimierten Beleg zurück, der in derselben Sitzung abgleichbar ist. | Vorgang, Status und Entwurfsreferenz. Ohne aktive Berechtigung werden keine Belegdaten offengelegt. |

Der nächste Ausbauschritt ist ein Office-Testmandant mit Projektzugang, einem fest gebundenen Nachtragsauftrag und einer autorisierten Maschinenidentität. In Office sind die vorhandene Finanz-Action und der aufrufende Policy-/Ledger-Pfad wiederzuverwenden. Eine direkte Credential-zu-Rolle-Zuordnung, der allgemeine API-Token-Scope und Browserzugang für einen Agenten erfüllen die Einmalfreigabe nicht.

## Lokalen Ablauf starten

Voraussetzungen sind Node 24, OpenSSL, die im Projekt gepinnte Flutter-Version und ein Android-Testgerät per ADB. Lege zuerst den lokalen Testaussteller, zwei getrennte Signaturschlüssel und das lokale TLS-Profil an.

```sh
npm ci --ignore-scripts --prefix apps/membership-pilot
preview_dir="$(node scripts/membership_wallet_preview.mjs init)"
node scripts/membership_wallet_preview.mjs verify-setup "$preview_dir"
node scripts/membership_wallet_preview.mjs serve "$preview_dir" &
```

Der Server bindet ausschließlich an `127.0.0.1:9444`. Öffne die ausgegebene HTTPS-Adresse in einem isolierten Testbrowser mit der lokalen Zertifikatsausnahme oder dem ausgegebenen Chromium-SPKI-Pin. Halte diese Browsersitzung für den Ergebnisabgleich geöffnet. Ein anderes Android-Gerät erreicht denselben Ursprung per `adb reverse tcp:9444 tcp:9444`. Der Android-Build bekommt nur `android-wallet.json` mit den öffentlichen Schlüsseln und dem lokalen CA-Zertifikat.

```sh
export HEAVENKEY_WALLET_PROFILE="$preview_dir/android-wallet.json"
cd apps/mobile
flutter pub get --enforce-lockfile
HEAVENKEY_ANDROID_PREVIEW=true flutter build apk --release --split-per-abi
```

1. Installiere die Vorschau für die passende ABI. Entsperre HeavenKey und öffne im Testbrowser **Testnachweis ausstellen**. Übergib den Link per QR oder auf demselben Gerät aus dem Browser. Prüfe den Testaussteller und speichere die Mitgliedschaft.
2. Wähle im ursprünglichen Browser **Projektzugang anfragen**. Gleiche die Vorgangskennung ab, prüfe Empfänger und Angaben auf Android und bestätige. **Ergebnis prüfen** zeigt anschließend den Zugang zum Testprojekt.
3. Wähle **Rechnungsentwurf freigeben**. Android zeigt den Testauftrag, 450,00 EUR, die Maschinenidentität, die Frist und die einmalige Verwendung. Die bestätigte Präsentation schaltet ausschließlich den **freigegebenen Auftrag** frei.
4. Öffne **Referenzen für den Agenten** und starte die CLI mit Auftragskennung und Wiederholungsschlüssel. Dieselbe Wiederholung liefert dieselbe Entwurfsreferenz. **Ergebnis prüfen** zeigt den erstellten Entwurf.

```sh
node scripts/membership_wallet_agent.mjs "$preview_dir" "$delegation_id" "$idempotency_key"
npm test --prefix apps/membership-pilot
```

Der Android-CI-Job provisioniert ein separates Testprofil und prüft auf einem API-36-Emulator mit seiner eigenen Geräte-PIN die Ausstellung, Projektfreigabe, Agentenaktion, Wiederholung und Widerruf. Die gemeinsame Vorschau verlangt dieses Ergebnis zum selben Quellcommit wie die Pakete. `PREVIEW.json` weist den Wallet-Test getrennt von der nativen Tresor-, Backup- und Autofill-Abnahme aus. Das allgemeine Download-APK hat den Wallet-Link ohne Testprofil deaktiviert.

Der Testdienst prüft Austausch über TLS auch mit einer unabhängigen Holder-Implementierung der OpenWallet Foundation. Der Test deckt dieses konkrete Profil ab. Ein Office-Testmandant, offizielle Konformitätsprüfung und die physische Geräteabnahme stehen weiterhin aus.

Die CLI benötigt im Betrieb nur `machine.json` und `ca.pem`. Halte `server.json`, SQLite und die privaten Aussteller-, Verifier- und TLS-Schlüssel beim Betreiber. Der Testordner enthält keine echten Benutzeridentitäten. Wenn du den synthetischen Aussteller zurücksetzt, erzeuge ein neues Profil mit neuen Schlüsseln und stelle Nachweise neu aus. Alte SQLite-Kopien mit denselben Schlüsseln können einen alten Status enthalten.

## Wiederherstellung und weitere AYA-Abläufe

- Android-Schlüssel für Nachweise bleiben bei ihrem Gerät. Verlust, Zurücksetzen, Wechsel des App-Kanals und gelöschte Gerätesperre werden im Pilot über Neuausstellung behandelt. Ein altes Password-/Passkey-Backup ändert den maßgeblichen Nachweisstatus nicht.
- Sitzungsende beendet die Zugriffsberechtigung dieser Sitzung. Nachweiswiderruf unterbindet weitere Verwendung. Eine aufgehobene Delegation sperrt den Einmalauftrag. Der Geräteaustausch im Pilot erfordert, dass ein Betreiber den bisherigen Nachweis widerruft.
- AYA ID/CONNECT nutzt zuerst Mitgliedschaft und Projektzugang. SIGN, PAY, ASSETS, LIFE, VOTE und COMMONS beantragen später definierte Operationen beim jeweiligen Ziel. Für SIGN ist der zuständige Signaturdienst maßgeblich, für PAY der Zahlungsdienst. Bei VOTE wird der Teilnahmenachweis getrennt von der Stimmverarbeitung behandelt. Freigabeansicht und Statusabgleich lassen sich wiederverwenden.
