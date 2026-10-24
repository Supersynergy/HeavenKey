# HeavenKey Mobile

Flutter-App für einen lokalen Android-/iPhone-Passworttresor mit nativer
Geräteauthentifizierung und verschlüsselter Sicherung. Entwicklungsversion für
Testdaten. Die Browserfreigabe ist noch nicht abgeschlossen; der alte Android-Pfad
bleibt gesperrt.

Build und offene Abnahmen: [Handy-Anleitung](../../docs/MOBILE.md).
Der Schnittstellenvertrag steht in [MOBILE-CONTRACT.md](../../docs/MOBILE-CONTRACT.md).

```sh
flutter pub get --enforce-lockfile
flutter run
```

Vom Repository-Root: `just mobile-backup-check` und `just mobile-android`.
