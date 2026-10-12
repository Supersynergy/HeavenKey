# HeavenKey 0.1: Passkeys und signierte Zugänge

Historischer Stand der ersten lokalen Demo. Die aktuelle Version und ihre Benutzung stehen in der [README](../README.md).

## Funktionen

- Konto mit einem Passkey einschreiben und anmelden.
- Ein signiertes Leserecht für ein Demo-Dokument erstellen.
- Den konkreten Aufruf mit einem frischen Passkey-Nachweis bestätigen.
- Zugriff an das berechtigte Konto binden und zeitlich begrenzen.
- Zugänge widerrufen und erneute Nutzung nach Neustart ablehnen.

SQLite speicherte sowohl Konten als auch Widerrufe und ausgeführte Operationen, während Rust bei jedem gebundenen Aufruf Identität und Zugangsrecht gemeinsam prüfte und unzulässige Operationen abwies. Die damalige Einrichtung wurde ab Version 0.2 so geändert, dass erst ein einmaliger Einrichtungscode die Eigentümerrolle vergibt und ein früher Gast dadurch kein Eigentümer wird.

## Prüfstand dieser Version

24 Rust-Tests und 35 Browserfälle mit virtuellen CTAP2-Geräten bestanden. Die Simulation prüfte tatsächliche WebAuthn-Antworten im Rust-Verifier, einschließlich veränderter Parameter, Replay, Ablauf, falscher Signaturen und Widerruf.

Die Demo verwendete eine künstliche Ressource und ein eigenes Tokenformat. Physische Geräte, externe Produkte und Protokollkompatibilität waren noch nicht abgenommen.

[Historische Abnahme](evidence/spike-acceptance.json) · [Aktueller Prüfstatus](VERIFICATION.md) · [Roadmap und Planung](ROADMAP.md)
