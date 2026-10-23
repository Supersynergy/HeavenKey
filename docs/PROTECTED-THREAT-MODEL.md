# Schutzgrenze geschützter Aufträge

Der geschützte Zugang trennt Agent, Besitzeroberfläche und privaten Anmeldebrowser. Er ist für strukturierte Entwürfe mit drei Referenzarten gebaut. Er bietet keine Garantie gegen jeden Informationsabfluss und macht einen bereits frei auf dem Host laufenden Agenten nicht nachträglich sicher.

## Geprüfte Abwehr und verbleibende Möglichkeiten

| Angreifer oder Fehler | Abwehr im Flow | Verbleibende Grenze |
| --- | --- | --- |
| Agent versucht Passwort, Cookie, Seite oder entschlüsseltes Dokument abzurufen | Eigene geschützte Identität; typisierte erlaubte Operationen; keine Sitzungsreferenz, Seitenlese- oder Entschlüsselungsoperation | Ein zusätzlicher freier Host-, Browser-, Docker- oder Administratorzugang umgeht diese Trennung. Shell-Agenten benötigen den eingeschlossenen Startweg. |
| Agent manipuliert Empfänger oder wiederholt Versand | Veröffentlichtes Ziel derselben Origin; verschlüsselte Hülle bindet Auftrag, Epoche, Revision und Entwurf; Versuch wird vor Dispatch verbraucht | Der Besitzer muss das sichtbare Ziel und den ganzen Text prüfen. Eine neue Freigabe ist eine neue Entscheidung. |
| Website ändert DNS nach Freigabe | Alle Antworten prüfen, private/gemischte Antworten ablehnen, eine öffentliche IP für den Browser fest binden | TLS und der freigegebene Zielserver müssen vertrauenswürdig sein. Ein kompromittierter Zielserver kennt die legitim empfangenen Daten. |
| Website signalisiert Geheimnisse über HTML, Antwort, Status oder Weiterleitung | Kein Inhaltskanal zum geschützten Agenten; Freigabestatus unabhängig vom Website-Ergebnis; Versand ohne Antwortinhalt und ohne Weiterleitung | Gemeinsame CPU, Netzwerkzeit, Hostressourcen und außerhalb dieses Kanals erreichbare Dienste können Nebenkanäle bilden. Eine konstante Laufzeit oder vollständige Nichtbeeinflussung wird nicht behauptet. |
| Widerruf, Sperren, Änderung, Ablauf oder verlorene Besitzerverbindung | Live-Rechte enden; Job und privates Browserprofil werden entfernt; keine automatische Wiederveröffentlichung | Ein bereits abgeschickter HTTP-Request und gespeicherte Kopien beim Empfänger lassen sich nicht zurückholen. |
| Viele abgeschlossene Agentenanfragen | Interne Anti-Replay-Tombstones bleiben erhalten; Besitzerprojektion blendet erledigte geschützte Requests aus | Ressourcen sind begrenzt. Erteilte Aufträge und Ratenlimits ersetzen keine vertrauenswürdige Hostverwaltung. |
| Speicher-, Bildschirm- oder Lieferkettenangriff | Verschlüsselter Tresor; private temporäre Profile; kein Clipboard im geschützten Flow; temporäre Bytepuffer werden bereinigt | JavaScript-Zeichenketten, Browser-/OS-Speicher und Administratorzugriff erlauben keine garantierte forensische Löschung. Pakete sind unsigniert und nicht notarisiert. |

## Betriebsentscheidungen

Verwende für externe Dienste eigene Konten mit den kleinsten erforderlichen Rechten. Veröffentliche nur die drei benötigten Angaben und halte Auftrag, Ziel und Laufzeit sichtbar. Für einen Versand benötigt die Website einen passenden authentifizierten Text-POST-Endpunkt. Eine erfolgreiche HTTP-Antwort bedeutet Serverannahme, keine Lesebestätigung. Bei unklarem Ergebnis zuerst beim Empfänger prüfen; HeavenKey wiederholt einen verbrauchten Versandversuch nicht.

Für freie Browserarbeit oder Dateitransfers gibt es getrennte, ausdrücklich freizugebende Agentenrechte. Deren Ausgaben können Website- oder Dateiinhalt enthalten. Sie dürfen nicht als geschützter Composer-Kanal behandelt werden. Pseudonyme anonymisieren keine beliebigen Freitexte; auch ein Agent kann private Angaben bereits aus anderen Quellen kennen.

## Nachweise

Der Release enthält eine Quellen- und Binärbindung in `ACCEPTANCE.json`. Die drei zusätzlichen Prüfungen warten die echten 300 Sekunden ab, wechseln DNS in einem eigenen Netz ohne WAN und senden den sichtbaren Text über einen echten privaten Browser. Angriffsdaten sind synthetisch. Der DNS-Versuch verwendet ein einzelnes Testzertifikat und einen ausdrücklich markierten Chromium-Testoverride im Container; er belegt keine Chromium-OS-Sandbox. Die Agenten-Sandbox wird getrennt am Linux-Kernel geprüft. Native Windows-Abnahme und ein externes Sicherheits-/Kryptografie-Audit stehen aus.

Die DNS-/Weiterleitungsprüfung folgt den Abwehrzielen des [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). Die konkrete Umsetzung und ihre Grenzen werden durch die oben genannten Produktprüfungen belegt.
