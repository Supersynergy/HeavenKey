"""Reproducible SVG instruction plates. Schematic UI illustrations, not browser screenshots."""

from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/images"
INK, MUTED, GOLD, PAPER, DARK = "#19323c", "#52696f", "#dfc596", "#f4f4ef", "#102b37"


def text(x, y, value, size=18, color=INK, weight=400):
    return f'<text x="{x}" y="{y}" font-family="Arial,Helvetica,sans-serif" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(value)}</text>'


def rect(x, y, w, h, fill, stroke="none", radius=12):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'


def lines(x, y, values, size=17, color=MUTED, gap=27):
    return "".join(text(x, y + i * gap, v, size, color) for i, v in enumerate(values))


def badge(x, y, number):
    return f'<circle cx="{x}" cy="{y}" r="20" fill="{GOLD}"/>' + text(
        x - 6, y + 7, str(number), 21, INK, 700
    )


def plate(filename, title, subtitle, body, height=660, source_version="0.7"):
    footer = f"Schematische Bedienillustration · Quellstand {source_version} · kein Screenshot / keine Browser-Abnahme"
    source = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}" role="img" aria-labelledby="title desc"><title id="title">{escape(title)}</title><desc id="desc">{escape(subtitle)}. Schematische Bedienillustration, kein Screenshot.</desc>{rect(0, 0, 1200, height, PAPER, radius=0)}{rect(0, 0, 1200, 110, DARK, radius=0)}{text(42, 45, "HeavenKey · Schritt für Schritt", 16, GOLD, 600)}{text(42, 85, title, 30, "#ffffff", 700)}{text(42, 148, subtitle, 18, MUTED)}{body}{text(42, height - 25, footer, 13, MUTED)}</svg>'''
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / filename).write_text(source + "\n")


def install():
    b = ""
    cards = [
        (
            "1",
            "Paket wählen",
            [
                "Mit berechtigtem GitHub-Konto",
                "v0.12.0 und SHA256SUMS laden.",
                "Prüfen, vollständig entpacken.",
            ],
        ),
        (
            "2",
            "Programm starten",
            [
                "Windows: Start HeavenKey.cmd",
                "Mac: Start HeavenKey.command",
                "Linux: ./start.sh",
            ],
        ),
        (
            "3",
            "Browser öffnen",
            [
                "localhost:18240/passwords/",
                "Programm geöffnet lassen.",
                "Die Erweiterung ist optional.",
            ],
        ),
    ]
    for i, (n, title, body) in enumerate(cards):
        x = 42 + i * 386
        b += (
            rect(x, 195, 356, 255, "white", "#d5ddda")
            + badge(x + 35, 230, n)
            + text(x + 25, 285, title, 25, INK, 700)
            + lines(x + 25, 325, body, 17)
        )
    b += (
        rect(42, 480, 1115, 90, "#e8eeea")
        + text(
            65, 513, "HeavenKey 0.12.0 · Lokaler Passwortmanager", 18, INK, 700
        )
        + text(
            65,
            546,
            "Masterpasswort anlegen → Login speichern → verschlüsselte Sicherung exportieren",
            18,
            INK,
        )
    )
    plate(
        "01-installation.svg",
        "In drei Schritten starten",
        "Das Paket startet den Passwortmanager. Passkey und Browser-Erweiterung sind optional.",
        b,
        source_version="0.12.0",
    )


def setup():
    b = (
        rect(42, 185, 700, 365, "white", "#d5ddda")
        + rect(42, 185, 700, 42, "#e5e9e6")
        + text(64, 212, "http://localhost:18241 · Zugangslabor", 16, INK)
    )
    b += text(70, 265, "Deine Schlüssel. Begrenzte Rechte.", 24, INK, 700)
    fields = [
        ("Name im Labor", "owner"),
        ("Einrichtungscode · nur für Eigentümer", "••••••••••••••••••••"),
    ]
    for i, (label, value) in enumerate(fields):
        y = 306 + i * 80
        b += (
            text(70, y, label, 15, MUTED)
            + rect(70, y + 12, 575, 42, PAPER, "#b9c8c5", 5)
            + text(85, y + 39, value, 18, INK)
        )
    b += rect(70, 480, 245, 44, DARK, radius=5) + text(
        92, 509, "Passkey erstellen", 18, "white", 700
    )
    b += badge(782, 243, 1) + lines(
        815, 238, ["Programm zeigt den Pfad zu", "owner-bootstrap.txt an."], 17, INK
    )
    b += badge(782, 335, 2) + lines(
        815, 330, ["Code aus dieser Datei", "ins Eigentümerfeld übertragen."], 17, INK
    )
    b += badge(782, 427, 3) + lines(
        815,
        422,
        ["Passkey am Gerät bestätigen.", "Danach mit Passkey anmelden."],
        17,
        INK,
    )
    b += text(
        70,
        593,
        "Als Gast: eigenen Namen wählen und das Einrichtungscode-Feld leer lassen.",
        18,
        INK,
    )
    plate(
        "02-erster-passkey.svg",
        "Deinen ersten Passkey einrichten",
        "Der lokale Einrichtungscode vergibt die Eigentümerrolle genau einmal.",
        b,
    )


def chrome():
    b = (
        rect(42, 190, 730, 355, "white", "#d5ddda")
        + rect(42, 190, 730, 43, "#e5e9e6")
        + text(65, 218, "chrome://extensions", 17, INK)
    )
    b += (
        text(70, 275, "Erweiterungen", 26, INK, 700)
        + text(500, 272, "Entwicklermodus", 16, MUTED)
        + rect(680, 251, 55, 27, "#36796c")
        + '<circle cx="721" cy="264.5" r="10" fill="white"/>'
    )
    b += rect(70, 310, 310, 48, PAPER, "#b9c8c5", 5) + text(
        90, 342, "Entpackte Erweiterung laden", 17, INK, 700
    )
    b += (
        rect(70, 390, 650, 113, PAPER, "#d5ddda")
        + text(95, 428, "HeavenKey", 22, INK, 700)
        + text(95, 463, "Ordner mit manifest.json auswählen", 17, MUTED)
    )
    b += badge(815, 250, 1) + lines(
        847, 245, ["ZIP entpacken.", "chrome://extensions öffnen."], 17, INK
    )
    b += badge(815, 352, 2) + lines(
        847, 347, ["Entwicklermodus aktivieren.", "Entpackten Ordner laden."], 17, INK
    )
    b += badge(815, 454, 3) + lines(
        847, 449, ["HeavenKey in der Leiste", "anheften und öffnen."], 17, INK
    )
    b += text(
        70,
        592,
        "Edge: dieselben Schritte unter edge://extensions mit dem Chromium-Paket.",
        18,
        INK,
    )
    plate(
        "03-chrome.svg",
        "Chrome: Erweiterung laden",
        "Chromium-Paket 0.12.0 verwenden; danach lokal koppeln und Formularaktionen bestätigen.",
        b,
        source_version="0.12.0",
    )


def firefox():
    b = (
        rect(42, 190, 730, 355, "white", "#d5ddda")
        + rect(42, 190, 730, 43, "#e5e9e6")
        + text(65, 218, "about:debugging#/runtime/this-firefox", 16, INK)
    )
    b += text(70, 278, "Dieser Firefox", 26, INK, 700) + text(
        70, 325, "Temporäre Erweiterungen", 20, INK, 600
    )
    b += rect(70, 352, 310, 48, PAPER, "#b9c8c5", 5) + text(
        90, 383, "Temporäres Add-on laden", 17, INK, 700
    )
    b += rect(70, 425, 650, 80, PAPER, "#d5ddda") + text(
        95, 461, "HeavenKey · manifest.json", 22, INK, 700
    )
    b += badge(815, 250, 1) + lines(
        847, 245, ["Firefox-ZIP entpacken.", "about:debugging öffnen."], 17, INK
    )
    b += badge(815, 352, 2) + lines(
        847, 347, ["Temporäres Add-on laden.", "manifest.json auswählen."], 17, INK
    )
    b += badge(815, 454, 3) + lines(
        847, 449, ["HeavenKey öffnen.", "Nach Neustart erneut laden."], 17, INK
    )
    b += text(
        70,
        592,
        "Dauerhafte Installation: Mozilla muss das Add-on signieren. Das Vorschau-ZIP ist unsigniert.",
        17,
        INK,
    )
    plate(
        "04-firefox.svg",
        "Firefox: Vorschau-Erweiterung laden",
        "Firefox ab 140 · Firefox-Paket 0.12.0 · temporär laden und danach lokal koppeln.",
        b,
        source_version="0.12.0",
    )


def access():
    b = ""
    cards = [
        (
            "1",
            "Du bestätigst",
            ["Empfänger: Anna", "Laufzeit: 30 Minuten", "Weitergaben: 1"],
        ),
        (
            "2",
            "Anna gibt weiter",
            ["Empfänger: Ben", "Laufzeit: 10 Minuten", "Weitergaben: 0"],
        ),
        (
            "3",
            "Du widerrufst",
            [
                "Annas Zugang endet.",
                "Bens abhängiger Zugang",
                "wird ebenfalls gesperrt.",
            ],
        ),
    ]
    for i, (n, title, body) in enumerate(cards):
        x = 42 + i * 386
        b += (
            rect(x, 195, 356, 255, "white", "#d5ddda")
            + badge(x + 35, 230, n)
            + text(x + 25, 285, title, 24, INK, 700)
            + lines(x + 25, 330, body, 18)
        )
    b += (
        rect(42, 480, 1115, 90, "#e8eeea")
        + text(65, 513, "Alle nutzen ihre eigenen Passkeys.", 20, INK, 700)
        + text(
            65,
            547,
            "HeavenKey prüft Rechte, Ablauf und Widerruf vor jeder geschützten Ausführung.",
            18,
            INK,
        )
    )
    plate(
        "05-zugaenge.svg",
        "Rechte teilen und wieder entziehen",
        "Geteilt wird ein begrenzter Zugang. Jeder bestätigt mit seinem eigenen Passkey.",
        b,
    )


def recovery():
    b = ""
    for i, (title, body) in enumerate(
        [
            (
                "Konto wiederherstellen",
                [
                    "Einmalcode aus der Sicherung.",
                    "Erstellt einen neuen Passkey.",
                    "Sperrt alte Passkeys und Agenten.",
                ],
            ),
            (
                "Tresor entschlüsseln",
                [
                    "Separater Tresorschlüssel.",
                    "Entschlüsselt deinen Tresor lokal.",
                    "Danach neuen Passkey berechtigen.",
                ],
            ),
        ]
    ):
        x = 42 + i * 579
        b += (
            rect(x, 195, 545, 250, "white", "#d5ddda")
            + badge(x + 36, 230, i + 1)
            + text(x + 25, 285, title, 25, INK, 700)
            + lines(x + 25, 330, body, 18)
        )
    b += (
        rect(42, 480, 1115, 90, "#e8eeea")
        + text(
            65, 514, "Sicherung herunterladen und getrennt aufbewahren.", 21, INK, 700
        )
        + text(
            65,
            548,
            "Für den Labor-Server: Datenordner UND Datenbank- und Signierschutzschlüssel sichern.",
            17,
            INK,
        )
    )
    plate(
        "06-recovery.svg",
        "Zwei Sicherungen für zwei Aufgaben",
        "Kontozugang und Entschlüsselung haben unabhängige Wiederherstellungswege.",
        b,
    )


def agent():
    b = rect(42, 195, 710, 360, "white", "#d5ddda") + text(
        70, 242, "Agentenauftrag freigeben", 25, INK, 700
    )
    rows = [
        ("Name", "Hotel-Assistent"),
        ("Ziel", "CRM-Beispielkontakt"),
        ("Rechte", "Lesen + Notiz ändern"),
        ("Gültigkeit", "1800 Sekunden"),
        ("Identität", "Eigener öffentlicher Ed25519-Schlüssel"),
    ]
    for i, (a, v) in enumerate(rows):
        y = 288 + i * 43
        b += text(70, y, a, 16, MUTED) + text(260, y, v, 17, INK)
    b += badge(802, 245, 1) + lines(
        835,
        240,
        ["Lokales Agentenprogramm", "erzeugt seinen eigenen Schlüssel."],
        17,
        INK,
    )
    b += badge(802, 350, 2) + lines(
        835, 345, ["Du bestätigst den genauen", "Auftrag mit deinem Passkey."], 17, INK
    )
    b += badge(802, 455, 3) + lines(
        835,
        450,
        ["Jeder Aufruf beweist den", "Schlüsselbesitz und prüft Rechte."],
        17,
        INK,
    )
    b += text(
        70,
        596,
        "Der CRM-Pilot nutzt synthetische Daten. Eine reale Next-Office-Anbindung folgt separat.",
        17,
        INK,
    )
    plate(
        "07-agenten.svg",
        "Agenten gezielt arbeiten lassen",
        "Befristete Aufgaben mit eigenem Schlüssel und jederzeit widerrufbaren Rechten.",
        b,
    )


def workflow(filename, title, subtitle, steps):
    """Numbered process cards; deliberately do not imitate browser dialogs."""
    body = ""
    for index, (heading, detail) in enumerate(steps):
        x, y = 42 + (index % 2) * 570, 185 + (index // 2) * 155
        body += (
            rect(x, y, 545, 137, "white", "#d5ddda")
            + badge(x + 32, y + 34, index + 1)
            + text(x + 64, y + 40, heading, 21, INK, 700)
            + lines(x + 22, y + 78, detail, 17)
        )
    plate(filename, title, subtitle, body, height=710, source_version="0.12.0")


def pairing():
    workflow(
        "08-browserkopplung.svg",
        "Browser verbinden: zwei bewusste Freigaben",
        "Schematischer Ablauf · Der native Berechtigungsdialog ist hier nicht abgebildet.",
        [
            ("App: Einstellungen", ["Browser-Erweiterung verbinden öffnen.", "Verbindungscode erzeugen wählen."]),
            ("Einmaligen Code kopieren", ["Code kopieren · gilt nur zwei Minuten.", "Nach Dienstneustart erneut koppeln."]),
            ("Erweiterung öffnen", ["Lokalen Port und Kopplungscode eintragen.", "Lokal verbinden wählen."]),
            ("Browserberechtigung bestätigen", ["Optionale Berechtigung: http://localhost/*", "Nach Ablehnung findet keine Kopplung statt."]),
            ("Popup mit Masterpasswort öffnen", ["Tresor entsperren wählen.", "Die Hauptseite entsperrt das Popup nicht."]),
            ("Zugriff bewusst beenden", ["Sperren oder Popup schließen.", "Verbindung entfernen oder in der App widerrufen."]),
        ],
    )


def autofill():
    workflow(
        "09-autofill.svg",
        "Autofill: prüfen, auswählen und bestätigen",
        "Schematischer Ablauf · Die Website kann bewusst ausgefüllte Werte lesen.",
        [
            ("Zielseite aktiv öffnen", ["HTTPS-Seite, dann HeavenKey-Symbol öffnen.", "Für Logins: Schema, Host und Port abgleichen."]),
            ("Login oder Profil auswählen", ["Popup mit Masterpasswort entsperren.", "Unter Werte prüfen die Angaben kontrollieren."]),
            ("Felder der Seite prüfen", ["Felder und ihre Zuordnung auswählen.", "Vorhandene Werte bleiben standardmäßig erhalten."]),
            ("Geheimnisse extra freigeben", ["Passwort und Einmalcode freigeben: nur bei Bedarf.", "Finanz- und Identitätsdaten: eigene Freigabe."]),
            ("Angezeigte Zielseite bestätigen", ["Ich gebe die ausgewählten Werte für … frei.", "Nur gewählte Felder füllen wählen."]),
            ("Ergebnis prüfen", ["Es wird kein Formular abgesendet.", "Rückgängig: unveränderte Seite, max. zwei Minuten."]),
        ],
    )


if __name__ == "__main__":
    for build in [install, setup, chrome, firefox, access, recovery, agent, pairing, autofill]:
        build()
    print("Created nine schematic SVG instruction plates (not screenshots).")

