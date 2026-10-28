# phone-lab

Steuert iPhones per USB vom Mac aus über eine lokale Kachel-Seite. Projektbrief: BRIEF.md.

## Dateien

- server.js: Node-Server ohne Zusatzpakete. Startet WDA je Gerät, überwacht es, reicht den Stream durch, nimmt Eingaben an. Nur 127.0.0.1:3000.
- index.html: Kachel-Seite.
- wda-start.sh: Startet WebDriverAgent auf einem iPhone plus Portweiterleitung über USB.
- devices.json: Geräte (UDID, Ports), Apple-Team-ID, Bundle-ID von WDA.
- smoke.sh: Rauchtest gegen den laufenden Server.
- setup.sh: Prüft und installiert alles auf einem frischen Mac, fragt vor jeder Installation.

## Einrichtung auf einem Mac (auch Umzug)

1. Repo auf den Mac kopieren (git clone von einem anderen Mac, USB-Stick oder AirDrop). logs/ nicht mitnehmen.
2. Xcode aus dem App Store installieren, einmal öffnen, Lizenz bestätigen. Xcode > Settings > Accounts > Plus > Apple-ID anmelden.
   Gleiche Apple-ID wie bisher: fertig. Andere Apple-ID: team_id in devices.json anpassen, setup.sh zeigt die neue Team-ID.
3. iPhones per USB anstecken. Auf jedem: "Diesem Computer vertrauen", dann Entwicklermodus einschalten
   (Einstellungen > Datenschutz und Sicherheit > Entwicklermodus, Neustart). Der Schalter erscheint erst, wenn das iPhone
   einmal mit dem Mac verbunden war und Xcode lief.
4. `./setup.sh` ausführen. Es prüft Werkzeuge, installiert fehlende nach Rückfrage, nimmt neue iPhones in devices.json auf
   (add-device.sh) und richtet den Autostart ein (install-launchd.sh). Beliebig oft ausführbar.
5. Beim ersten Start baut der Server WDA je iPhone und lädt es aufs Gerät (ein paar Minuten je Gerät, siehe logs/handy-N.log).
   Danach auf jedem iPhone: Einstellungen > Allgemein > VPN und Geräteverwaltung > Entwickler-App vertrauen.
6. http://127.0.0.1:3000 öffnen.

Damit der Server nach einem Neustart des Macs ohne Zutun läuft: Systemeinstellungen > Benutzer > automatische Anmeldung
für den Benutzer einschalten (bei FileVault muss nach dem Neustart trotzdem einmal das Passwort eingegeben werden).
Der Mac sollte am Netzteil hängen. Der Bildschirm darf ausgehen, der Mac selbst schläft nicht (caffeinate -is).

Ein weiteres iPhone später hinzufügen: anstecken, vertrauen, Entwicklermodus an, `./setup.sh` nochmal.

## Betrieb

- Logs: logs/server.log (Server), logs/handy-N.log (WDA je Gerät).
- Neustart: `launchctl kickstart -k gui/$(id -u)/com.phonelab.server`
- Stoppen: `launchctl bootout gui/$(id -u)/com.phonelab.server`
- Ohne Autostart von Hand: `node server.js`
- WDA wird automatisch neu gebaut, wenn ein Gerät neu ist oder der Build älter als 6 Tage ist (kostenlose Apple-ID: Signatur gilt 7 Tage).
- Stürzt WDA auf einem Gerät ab, startet der Server es nach 5 s neu. Antwortet es 30 s nicht, wird es abgeschossen und neu gestartet.

## Bedienung der Kachel

- Klick = tippen. Shift+Klick = Doppeltipp (Like). Linke Taste gedrückt ziehen = wischen entlang der Mausspur.
- Textfeld + Enter tippt in das Feld, das auf dem iPhone den Fokus hat.
- Knöpfe: Home, Instagram, Groß.

## Grenzen

- Kostenloses Apple-Konto: Signatur läuft nach 7 Tagen ab, WDA wird dann automatisch neu gebaut. Ein bezahltes
  Developer-Konto (Signatur 1 Jahr) ist bei 10 Geräten die ruhigere Wahl.
- Etwa 0,5 s Latenz je Tipp, das ist die Grundlatenz von XCTest.
- Last je Gerät am Mac: etwa 170 MB RAM und 3 % CPU (xcodebuild hält die Testsitzung, dazu iproxy). Bei 10 Geräten
  grob 2 GB RAM und ein Drittel eines Kerns, plus den Browser mit 10 Streams.
