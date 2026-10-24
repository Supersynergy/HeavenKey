# HeavenKey Mobile

Flutter-App für einen lokalen Android-/iPhone-Passworttresor mit nativer
Geräteauthentifizierung und verschlüsselter Sicherung. Entwicklungsversion für
Testdaten. Android verlangt vor jeder Browserfreigabe eine ausdrückliche
Einmalberechtigung für die gemeldete HTTPS-Domain. Die signierte iPhone-Abnahme
und die Prüfung auf physischen Telefonen stehen aus.

Build und offene Abnahmen: [Handy-Anleitung](../../docs/MOBILE.md).
Der Schnittstellenvertrag steht in [MOBILE-CONTRACT.md](../../docs/MOBILE-CONTRACT.md).

```sh
flutter pub get --enforce-lockfile
flutter run
```

Vom Repository-Root: `just mobile-adaptive-check` und `just mobile-android`.
