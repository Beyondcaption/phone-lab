# phone-lab

Steuert iPhones per USB vom Mac aus über eine lokale Kachel-Seite. Projektbrief: BRIEF.md.

Es gibt zwei Rollen von Macs:

- **Entwicklungs-Mac** (mit Xcode und Apple-ID): signiert WDA einmal für alle iPhones (`build-wda.sh`) und packt das Paket (`make-package.sh`).
- **Betriebs-Mac** (ohne Xcode, ohne Homebrew): entpackt das Paket, Doppelklick auf `Start.command`, fertig.

## Dateien

- server.js: Node-Server ohne Zusatzpakete. Startet WDA je Gerät über go-ios, überwacht es, reicht den Stream durch, nimmt Eingaben an. Nur 127.0.0.1:3000.
- index.html: Kachel-Seite.
- usbmux.js, plist.js: Portweiterleitung über Apples USB-Dienst usbmuxd, ersetzt iproxy.
- add-device.js: nimmt angesteckte iPhones in devices.json auf, blendet den Entwicklermodus-Schalter ein.
- devices.json: Geräte (UDID, Ports), Apple-Team-ID, Bundle-ID von WDA.
- setup.sh, Start.command, install-launchd.sh: Einrichtung und Autostart auf dem Betriebs-Mac.
- build-wda.sh, make-package.sh: nur Entwicklungs-Mac.
- smoke.sh: Rauchtest gegen den laufenden Server (`H=2 ./smoke.sh` für Handy 2).
- bin/ (Node, go-ios), wda/ (signierte WDA-App), devimages/ (Entwicklerbilder): Teil des Pakets, nicht im git.

## Ablauf auf dem Entwicklungs-Mac

1. Xcode mit Apple-ID (bezahltes Developer-Programm: Signatur gilt 1 Jahr; kostenlos: 7 Tage).
2. Alle iPhones nacheinander anstecken: "Diesem Computer vertrauen", Entwicklermodus an, `node add-device.js`.
3. `./build-wda.sh` baut WDA und trägt alle Geräte aus devices.json ins Signaturprofil ein. Jedes Gerät muss dabei einmal angesteckt gewesen sein.
4. `./make-package.sh` legt phone-lab-paket.tar.gz auf den Schreibtisch (lädt einmalig Node von nodejs.org).

## Ablauf auf dem Betriebs-Mac

1. Archiv in den Benutzerordner, Doppelklick entpackt es.
2. iPhones anstecken, auf jedem "Diesem Computer vertrauen".
3. Im Ordner phone-lab Doppelklick auf `Start.command`. Es prüft das Paket, nimmt die iPhones auf, richtet den Autostart ein und öffnet die Kachel-Seite.
4. Auf jedem iPhone einmal: Einstellungen > Allgemein > VPN und Geräteverwaltung > Entwickler-App vertrauen.

Ohne Zutun nach Neustart des Macs: Systemeinstellungen > Benutzer > automatische Anmeldung einschalten (bei FileVault bleibt die
Passworteingabe nach dem Neustart). Mac am Netzteil. Der Bildschirm darf ausgehen, der Mac selbst schläft nicht (caffeinate -is).
Der Betriebs-Mac braucht kein Internet, außer wenn ein iPhone eine iOS-Version hat, für die kein Entwicklerbild in devimages/ liegt.

## Betrieb

- Logs: logs/server.log (Server), logs/handy-N.log (WDA je Gerät), logs/tunnel.log.
- Neustart: `launchctl kickstart -k gui/$(id -u)/com.phonelab.server`
- Stoppen: `launchctl bootout gui/$(id -u)/com.phonelab.server`
- Ohne Autostart von Hand: `bin/node server.js`
- Stürzt WDA auf einem Gerät ab, startet der Server es nach 5 s neu. Antwortet es 30 s nicht, wird es abgeschossen und neu gestartet.
- Neues iPhone: auf dem Entwicklungs-Mac aufnehmen und `./build-wda.sh` (Signaturprofil), neues Paket, auf dem Betriebs-Mac `Start.command`.
- Signatur abgelaufen (Datum zeigt setup.sh): auf dem Entwicklungs-Mac `./build-wda.sh` und `./make-package.sh`, neues Paket einspielen.

## Bedienung der Kachel

- Klick = tippen. Shift+Klick = Doppeltipp (Like). Linke Taste gedrückt ziehen = wischen entlang der Mausspur, mit Leuchtspur.
- Textfeld + Enter tippt in das Feld, das auf dem iPhone den Fokus hat.
- Knöpfe: Home, Instagram, Groß.

## Grenzen

- Etwa 0,5 s Latenz je Tipp, das ist die Grundlatenz von XCTest.
- Last je Gerät am Mac: etwa 60 MB RAM für go-ios plus Stream, bei 10 Geräten grob 1 GB und ein Viertel eines Kerns, plus Browser.
- Der Tunnel-Dienst von go-ios mit mehreren Geräten gleichzeitig ist hier nur mit einem Gerät getestet.
