# HeavenKey 0.27 Alpha

Diese Alpha ergänzt die Erste-Schritte-Anleitung um zufällige Beispieldaten. Wer noch keine eigenen Logins hat, fügt drei Testeinträge ein, probiert Suche, Sicherheitscheck, Generator und Sicherung aus und entfernt sie danach wieder. Die [Einstiegsanleitung](ONBOARDING.md) beschreibt beide Aktionen.

## Beispieldaten

- Drei Einträge mit dem Tag `Beispiel`, Benutzernamen auf `@example.invalid` und HTTPS-Adressen auf reservierten `.example`-Domains (RFC 2606). Sie können keine echte Website erreichen.
- Passwörter entstehen bei jedem Einfügen neu über den kryptografischen Zufallsgenerator des Browsers (20 Zeichen). Jeder Eintrag trägt im Notizfeld den Hinweis, dass er zu keinem echten Konto gehört.
- „Beispieldaten entfernen“ fragt einmal nach und löscht ausschließlich Einträge mit dem Tag `Beispiel`. Eigene Logins bleiben unverändert, auch bei gleichem Titel.
- Regressionstests in `apps/web/src/passwords-onboarding-samples.test.ts` prüfen Zufallsquelle, Ergebnismenge, Kollisionsfreiheit, Grenzwerte der Zufallsfunktion, gemischte Tresore und die Gültigkeit nach `validateVault`.

## Abnahme auf macOS

Der lokale Rust-Dienst (`uac-api`, Version 0.27.0) lief mit isoliertem Datenordner; `mk` steuerte einen sichtbaren Helium-Browser über CDP:

1. Tresor mit einem synthetischen Masterpasswort anlegen.
2. „Erste Schritte“ → „Beispieldaten einfügen“: drei Einträge, Tag `Beispiel`, `https://fotoalbum.example`, `beispiel@example.invalid`.
3. Neu laden und entsperren: die drei Einträge bleiben erhalten (Persistenz im verschlüsselten SQLite-Tresor).
4. „Beispieldaten entfernen“ → Bestätigung: 0 Einträge; der leere Zustand bietet „Ersten Login anlegen“ an.
5. `strings passwords.sqlite` findet weder `fotoalbum` noch `example.invalid` – der Tresor bleibt verschlüsselt.

## Grenzen

Dieses Alpha-Paket enthält fünf Desktop-Pakete und zwei Browser-Erweiterungen. Es enthält keine neue Android-APK; Android bleibt bei der getrennten [0.28-Vorschau](https://github.com/Supersynergy/HeavenKey/releases/tag/android-v0.28.0-preview.1). Pakete bleiben ohne Herausgebersignatur und ohne externes Kryptografie-Audit. Eine gemessene Zeitersparnis gegenüber anderen Passwortmanagern wird nicht behauptet.
