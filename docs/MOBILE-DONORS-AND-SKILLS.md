# Bausteine und Skills für HeavenKey Mobile

Stand: 24. Oktober 2026. `metacode plan --check` und SPD wurden vor dem Bau
verwendet. Der generische Katalog schlug unter anderem Capacitor, Automerge und
OpenBao vor. Diese Bausteine wurden nicht übernommen: Flutter war vorgegeben;
Autofill, lokale Verschlüsselung und Geräteauthentifizierung werden von den
Plattformschnittstellen abgedeckt. SPD fand für diese konkrete Kombination keinen
passenden lokalen Code-Donor. Sachfremde Treffer wurden verworfen.

Es wurde kein Code aus Bitwarden, KeePassXC oder einem anderen Passwortmanager
kopiert. Die vorhandenen HeavenKey-Implementierungen und offiziellen SDKs sind die
Baubasis. Die UCAN-Brücke und CLI stammen aus den eigenen, zuvor getrennten
HeavenKey-Branches; ihre Herkunft steht im Migrationsnachweis.

## Zehn ausgewählte Atlas-Skills

Die Auswahl passt zu diesem Auftrag und ist keine allgemeine Rangliste.

| Skill | Verwendung |
|---|---|
| metacode | Lizenzgrenzen und Bausteine prüfen |
| superpromptdonor / SPD | Donor-Suche und ausführbarer Liefervertrag |
| aiworkflow | SIS-Dateigrenzen und ausführbare Abnahme |
| ponytail | Betriebssystem-APIs vor zusätzlichen Laufzeitbibliotheken |
| hallmark | Vorhandene goldene Schlüsselmarke und blaue Bedienfarben erhalten |
| android-clean-architecture | Plattformcode von Flutter-Oberfläche trennen |
| senior-security | Gerätesperre und Abbruchpfade prüfen |
| flutter-dart-code-review | Asynchrone Antworten und Widgetzustände prüfen |
| verification-loop | Build, Analyse, Tests, Sicherheitsprüfung und Diff-Review |
| antislop | README und Abnahmegrenzen verständlich formulieren |

`si atlas --json`, `si find` und `si resolve` bestätigten die lokalen Skill-Quellen.
Die vollständigen Skilltexte wurden nicht in das Produkt oder einen permanenten
Prompt übernommen. Eine optionale Delegation wurde von der Capsule-Prüfung
abgewiesen; die Implementierung wurde in diesem Chat fortgesetzt.

## Nachweise

Der Android-Build und die Flutter-Tests haben eigene Prüfprotokolle. Ein
Sicherheits-Scan meldete GCM-Verwendung zur manuellen Nonce-Prüfung: jede
Verschlüsselung erzeugt mit `Cipher.init(ENCRYPT_MODE, key)` eine neue IV; eine
explizite IV wird ausschließlich beim Entschlüsseln verwendet. Im finalen mobilen
Diff meldete der Geheimnis-Scan sechs SHA-256-Dateihashes als mögliche Schlüssel.
Die 88 Treffer des zusammengeführten Core-Diffs stammen aus unveränderten
synthetischen UCAN-Testvektoren. Hashes und Einordnung stehen in
`docs/evidence/mobile/secrets-triage.json`. Historische Treffer und Heuristiken
ersetzen keine Sicherheitsreview.
