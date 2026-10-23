# HeavenKey: Stand und nächste Abnahmen

## Stand 0.20

Der lokale Passwortmanager enthält verschlüsselte Logins, Formularprofile, Importvorschau mit Duplikatprüfung, Passkey-Entsperren bei kompatiblem PRF-Authenticator, befristete Feldfreigaben, SSH-Schlüsselverwaltung sowie SFTP/FTPES-Broker. Geschützte Aufträge verwenden Pseudonyme und einen getrennten Login-Browser. Die Freigabe bleibt ausdrücklich beim Eigentümer.

0.20 ergänzt ein macOS-App-Fenster mit verwaltetem lokalem Dienst, flüchtigem WebKit-Kontext, nativen Datei-Dialogen und Tastaturmenüs. Der Windows-SSH-Build verwendet die vorhandene OpenSSL-Unterstützung der Bibliothek. Windows und Linux verwenden weiterhin den Systembrowser als Oberfläche. Die Einrichtungshilfe führt direkt zur Transfer- oder Agenteneinrichtung, ohne Rechte zu vergeben.

Die [Customer Journey](CUSTOMER-JOURNEY.md) beschreibt die Bedienung. Plattform-, Build- und Runtime-Nachweise stehen im jeweiligen Releasebericht; eine implementierte Funktion ist kein pauschaler Sicherheitsnachweis.

## Offene Produktabnahmen

| Bereich | Erforderlicher Nachweis |
| --- | --- |
| Windows | Echter Windows-Kernel mit Hello/PRF. Sandbox-Angriffspfade müssen dort ausgeführt werden. Wine ersetzt diese Abnahme nicht. |
| macOS-Verteilung | Herausgebersignatur, Notarisierung und Installation auf einem fremden Mac. Ad-hoc-Siegel bestätigen keine Herausgeberidentität. |
| Physische Passkeys | Geräte- und Betriebssystem-Matrix mit Enrollment, Entsperren, Abbruch und Verlust. |
| Firefox | Mozilla-Signierung und dauerhafte Installation nach Neustart. |
| Native Windows-/Linux-Fenster | Eigene Desktop-Shell samt Lifecycle, Datei-Dialogen, WebAuthn- und Sicherheitsabnahme. |
| Externe Connectoren | Reale Zielsysteme, Tenant-Zuordnung, Widerruf, Fehler und Wiederholungen am tatsächlichen Ausführungspunkt. |
| Sicherheitsprüfung | Unabhängiges Audit; vertrauenswürdiger Host und Zielwebsite bleiben Voraussetzungen. |

Das getrennte Zugangslabor und seine Mandanten-/Offline-Bibliotheken sind keine vollständige Cloud- oder Unternehmensbereitstellung des Passwortmanagers.
