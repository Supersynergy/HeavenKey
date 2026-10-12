# HeavenKey 0.4: Änderungen mit Passkey bestätigen

Version 0.4 ergänzt serverseitig geprüfte Zustimmung für sensible Änderungen. Eine angemeldete Sitzung allein reicht dafür nicht aus.

## Geschützte Aktionen

- Einen Passkey hinzufügen.
- Einen Passkey widerrufen.
- Einen direkten Zugang erstellen.
- Einen direkten Zugang widerrufen.

Vor der Bestätigung zeigt die Oberfläche die konkrete Aktion und ihre Parameter. Der Server bindet die Freigabe an die konkreten Angaben und das bestätigende Konto; die Sitzung sowie der verwendete aktive Schlüssel müssen ebenfalls übereinstimmen. Die Frist beträgt 60 Sekunden. Weil auch ein manipulierter Verbrauchsversuch die Freigabe ungültig macht, kann dieselbe Zustimmung danach weder erneut benutzt noch für eine andere Aktion umgedeutet werden.

Neustart und Schlüsselwiderruf verwerfen offene Freigaben. Der Passkey-Dialog lässt sich abbrechen und anschließend erneut starten.

## Prüfstand dieser Version

36 Rust-Tests und 96 virtuelle Browserfälle bestanden. Geprüft wurden unter anderem Ablehnungen ohne frische Zustimmung, veränderte Empfänger und Laufzeiten, falsche Sitzung, Replay, paralleler Verbrauch, Ablauf, Widerruf und Neustart.

Die Bestätigung bindet die Aktion an die WebAuthn-Challenge. Sie bietet keine unabhängige Anzeige der Transaktionsdaten auf dem Authentikator. Physische Geräte waren noch nicht abgenommen.

[Aktionsvertrag](STEPUP-CONTRACT.md) · [Sicherheitsprüfung](STEPUP-REVIEW.md) · [Historische Abnahme](evidence/acceptance-v04.json) · [Aktuelle Anleitung](USAGE.md)
