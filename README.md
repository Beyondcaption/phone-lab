# phone-lab

Steuert iPhones per USB vom Mac aus über eine lokale Kachel-Seite. Projektbrief: BRIEF.md.

Es gibt zwei Rollen von Macs:

- **Entwicklungs-Mac** (mit Xcode und Apple-ID): signiert WDA einmal für alle iPhones (`build-wda.sh`) und packt das Paket (`make-package.sh`).
- **Betriebs-Mac** (ohne Xcode, ohne Homebrew): entpackt das Paket, Doppelklick auf `Start.command`, fertig.

## Dateien

- server.js: Node-Server ohne Zusatzpakete. Startet WDA je Gerät über go-ios, überwacht es, reicht den Stream durch, nimmt Eingaben an. Nur 127.0.0.1:3000.
- index.html: Dashboard (Phones, Warmup, Insights, Team, Snippets & notes), charts.js: Diagramme dazu (taste-skill, ohne Pakete).
- warmup.js: Warmup je Handy im Serverprozess (14-Tage-Plan, Claude-Scroll-Sitzungen, VA-Ziele, Wächter). Zustand in warmup.json, Log logs/scroll.jsonl, Alarme logs/alerts.log.
- scroll.js: nur noch Selbsttest der Wisch- und Verweil-Verteilungen (`node scroll.js --dry`).
- test/: `node test/e2e.js` prüft Server und Warmup gegen nachgemachte Handys (geht auch auf Windows), `node test/demo.js` startet eine Vorschau mit Beispieldaten unter http://127.0.0.1:3000.
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
3. Einmalig die macOS-Sperre für heruntergeladene Dateien aufheben, sonst meldet macOS "Start.command ist beschädigt".
   Im Terminal: `xattr -dr com.apple.quarantine ~/phone-lab`
   Dann im Ordner phone-lab Doppelklick auf `Start.command`. Es prüft das Paket, nimmt die iPhones auf, richtet den Autostart ein und öffnet die Kachel-Seite.
4. Mit dem bezahlten Developer-Konto ist kein Vertrauens-Schritt auf dem iPhone nötig, WDA startet direkt.
   (Nur bei einer kostenlosen Apple-ID: Einstellungen > Allgemein > VPN und Geräteverwaltung > Entwickler-App vertrauen.)

Ohne Zutun nach Neustart des Macs: Systemeinstellungen > Benutzer > automatische Anmeldung einschalten (bei FileVault bleibt die
Passworteingabe nach dem Neustart). Mac am Netzteil. Der Bildschirm darf ausgehen, der Mac selbst schläft nicht (caffeinate -is).
Der Betriebs-Mac braucht kein Internet, außer wenn ein iPhone eine iOS-Version hat, für die kein Entwicklerbild in devimages/ liegt.

## Verschicken als App (empfohlen)

Entwicklungs-Mac: `./make-app.sh` baut phone-lab-<version>.dmg auf dem Schreibtisch, `./make-app.sh --release "Notiz"` lädt es
zusätzlich als Release nach https://github.com/Beyondcaption/phone-lab/releases hoch. Version steht in VERSION und zählt automatisch hoch.

Betriebs-Mac: DMG öffnen, phone-lab in den Programme-Ordner ziehen, dort doppelklicken. Beim ersten Mal blockt macOS die
unsignierte App: Systemeinstellungen > Datenschutz & Sicherheit > "Dennoch öffnen", oder im Terminal
`xattr -dr com.apple.quarantine /Applications/phone-lab.app`. Die App fragt beim ersten Start nach einem Admin-Namen und
Passwort (oder übernimmt Benutzer, Einstellungen und Logs aus einer älteren Installation unter ~/phone-lab oder ~/Desktop/phone-lab),
richtet den Autostart ein, startet die Tailscale-Freigabe, wenn Tailscale installiert ist, und öffnet das Dashboard.

Daten liegen unter ~/Library/Application Support/phone-lab (users.json, settings.json, logs, devimages, Pairing). Update: neue DMG,
App im Programme-Ordner ersetzen, einmal doppelklicken. Die App läuft als Hintergrunddienst (kein Dock-Symbol), Doppelklick öffnet nur das Dashboard, im Fenster von phone-lab Desk, wenn die App installiert ist, sonst im Browser.

## Aktualisieren von Hand

1. Entwicklungs-Mac: ändern, testen, committen, dann `./make-package.sh`.
2. Betriebs-Mac, Archiv im selben Ordner wie der bestehende Ordner phone-lab:
   `tar -xzf phone-lab-paket.tar.gz && xattr -dr com.apple.quarantine phone-lab && launchctl kickstart -k gui/$(id -u)/com.phonelab.server`
   Benutzer, Logs und Pairings bleiben erhalten, sie sind nicht im Paket. Nur index.html geändert: Datei kopieren reicht, kein Neustart.

## Betrieb

- Logs: logs/server.log (Server), logs/handy-N.log (WDA je Gerät), logs/tunnel.log.
- Neustart: `launchctl kickstart -k gui/$(id -u)/com.phonelab.server`
- Stoppen: `launchctl bootout gui/$(id -u)/com.phonelab.server`
- Ohne Autostart von Hand: `bin/node server.js`
- Stürzt WDA auf einem Gerät ab, startet der Server es nach 5 s neu. Antwortet es 30 s nicht, wird es abgeschossen und neu gestartet.
- Neues iPhone: auf dem Entwicklungs-Mac aufnehmen und `./build-wda.sh` (Signaturprofil), neues Paket, auf dem Betriebs-Mac `Start.command`.
- Signatur abgelaufen (Datum zeigt setup.sh): auf dem Entwicklungs-Mac `./build-wda.sh` und `./make-package.sh`, neues Paket einspielen.

## Zugriff für VAs (Phase 4)

Der Server lauscht weiterhin nur auf 127.0.0.1. Nach außen kommt die Seite über Tailscale Serve, das auf 127.0.0.1:3000
weiterleitet. Der Mac selbst ist aus dem Internet nie erreichbar, die Seite nur für Mitglieder des Tailnets.

### Tailscale einrichten (einmalig je Mac)

1. Tailscale-App installieren und mit dem eigenen Konto anmelden.
2. In der Admin-Konsole unter DNS "HTTPS Certificates" einschalten. Dann Freigabe:
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000` (bleibt nach Neustart erhalten).
   Adresse im Tailnet: https://<mac-name>.<tailnet>.ts.net, hier https://macbook-air-von-berkin.tail330fca.ts.net
3. VAs einladen: Admin-Konsole > Users > Invite. Jede VA installiert Tailscale auf ihrem Rechner und meldet sich an.
4. VAs auf die Seite beschränken (Admin-Konsole > Access controls), den Mac vorher mit tag:phonelab versehen:

```
{
  "tagOwners": { "tag:phonelab": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:admin"],  "dst": ["*:*"] },
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:phonelab:80,443"] }
  ]
}
```

Damit erreichen VAs nur Port 80 und 443 des Macs, sonst nichts im Tailnet.

- Benutzer anlegen: `node user.js add <name>` sieht alle Handys, `node user.js add <name> --handys 1,2,3` nur diese (Passwort wird abgefragt, mindestens 10 Zeichen, nur als Hash gespeichert).
  Admin, der alle Handys sieht: `node user.js add <name> --admin`. Weitere Befehle: `list`, `handys <name> 1,2`, `remove <name>`.
- users.json liegt nicht im git und nicht im Paket. Ohne Benutzer startet der Server nicht.
- Jede VA sieht nur ihre Handys. Ein Handy ist belegt, solange jemand in den letzten 2 Minuten einen Befehl geschickt hat;
  andere sehen "In Benutzung von ...", Befehle werden abgelehnt.
- Protokoll in logs/zugriff.log: Zeit, Benutzer, IP, Ereignis (Login, Logout, Übernahme eines Handys, jeder Befehl).
- Nach 5 falschen Passwörtern ist der Name von dieser IP 1 Minute gesperrt.
- Endpunkte: nur Login, Logout, Geräteliste, Stream, tap, doubletap, swipe, text, home, instagram. Nichts für Dateien, Befehle, Einstellungen.

### Checkliste iPhones absichern (in dieser Reihenfolge)

1. Zuerst WDA installieren (passiert beim ersten Start des Servers). Danach erst sperren,
   denn das Verbot "Apps installieren" blockiert auch die WDA-Installation.
2. Kein Mail-Konto auf dem Handy (Einstellungen > Mail > Accounts). Instagram-2FA nicht auf demselben Handy.
3. Bildschirmzeit mit eigenem Code: Einstellungen > Bildschirmzeit > Bildschirmzeit-Code festlegen (nicht der Geräte-Code).
4. Beschränkungen > Käufe im iTunes & App Store: Installieren "Nicht erlauben", Apps löschen "Nicht erlauben".
5. Beschränkungen > Änderungen zulassen: Code-Änderungen "Nicht erlauben", Account-Änderungen "Nicht erlauben".
6. Beschränkungen > Erlaubte Apps: nur das Nötige (Instagram, Einstellungen bleibt). WDA zählt nicht als App in dieser Liste und läuft weiter.
7. WLAN und Bluetooth aus lassen; Beschränkungen > Änderungen zulassen > Mobilfunkdaten-Änderungen "Nicht erlauben".

Was WDA braucht und von den Sperren nicht berührt wird: Entwicklermodus (bleibt an), USB.
Einmal im Jahr (neue Signatur) muss "Installieren" kurz wieder erlaubt werden, dann neues Paket einspielen, dann wieder sperren.

### Mac

FileVault an, Firewall an (geprüft am 28.10.2026). Automatische Anmeldung nur, wenn der Mac physisch sicher steht.

## Bedienung (Oberfläche auf Englisch)

- Raster aller Handys, Klick auf den Namen öffnet den Focus (groß, Tastenkürzel, Snippets, direktes Tippen mit T).
- Klick = tippen, Shift+Klick = Doppeltipp (Like), Rechtsklick halten = langer Druck, Ziehen = wischen mit Leuchtspur, Back = Wisch vom linken Rand.
- Auto-scroll je Handy oder für alle (Start/Stop in der Leiste), stoppt bei jedem Klick ins Bild, nach 20 min und beim Tab-Wechsel.
- Stream-Stufe Light/Normal/Smooth je Browser, das Handy im Focus läuft immer flüssig.
- Admin: Users (Benutzer, Handys, Tagesziele), Snippets & notes (Textbausteine global und je Handy, Beschriftung, Notiz), Insights (Zeit je Benutzer und Handy, 30-Tage-Verlauf, CSV-Export, Ereignisse), Reboot je Handy im Focus.
- Jeder sieht in der Leiste seine Tageswerte und Ziele. Apps in devices.json unter "apps" (Name: Bundle-ID).
- settings.json (Snippets, Notizen, Ziele) und users.json bleiben beim App-Update erhalten.

## phone-lab Desk (Desktop-App für Mac und Windows)

- Ordner desktop/: Electron-App, die das Dashboard in einem eigenen Fenster zeigt. Auf dem Mac mit den iPhones verbindet sie sich von selbst mit dem lokalen Server (die phone-lab.app im Hintergrund bleibt der Server), auf den Rechnern der VAs fragt sie einmal nach der Tailscale-Adresse des Macs. Menü Server: Adresse ändern, Neu laden, Updates prüfen. Neue Alarme kommen als Systembenachrichtigung.
- Bauen: Tag `desktop-vX.Y.Z` pushen, GitHub Actions (.github/workflows/desktop.yml) baut Windows-Installer + latest.yml und je ein Mac-DMG für Intel und Apple Silicon und hängt sie an das Release.
- Updates: Der Server reicht die Release-Dateien unter /desktop/ durch, dafür `GITHUB_TOKEN=...` (fine-grained, nur Lesen, Contents, Repo phone-lab) in die .env des Servers. Windows installiert Updates selbst, der Mac lädt das neue DMG in den Download-Ordner (ohne Quarantäne). Ohne Token bleibt jede App einfach auf ihrer Version.
- Mac, erster Start der unsignierten App: Systemeinstellungen > Datenschutz & Sicherheit > "Dennoch öffnen", oder `xattr -dr com.apple.quarantine "/Applications/phone-lab Desk.app"`.
- Lokal: `cd desktop && npm install && npm start`, Installer mit `npm run build:win` bzw. `build:mac`.

## Warmup

- Admin trägt je Handy unter Warmup ein Startdatum und die Nische ein. Ab dem Tag gilt die 14-Tage-Vorlage (ebenda änderbar): Claude-Minuten und Sitzungen, Likes und Kommentare als Tagesziel der VA, Post-Tage.
- Claude wischt nur (Reels, Verweildauer nach Nische), keine Likes, Kommentare, Follows, DMs, Profilbesuche. Sitzungen starten zufällig im Zeitfenster, mindestens 90 min Abstand. Während einer Sitzung ist das Handy als Claude belegt; jeder Befehl einer VA oder "Take over" beendet sie sofort.
- Bewertung je Reel mit Haiku 5.5 (ein Standbild, etwa 0,02 Cent), nur wenn `ANTHROPIC_API_KEY` in `~/Library/Application Support/phone-lab/.env` steht. Ohne Key wird ohne Nischen-Bewertung gescrollt. Kosten je Handy und Tag stehen unter Warmup.
- Wächter: Stoppwörter (Captcha, ungewöhnliche Aktivität, Sperre) oder eine Warnung laut Claude beenden die Sitzung, nehmen das Handy aus dem Plan und zeigen einen roten Hinweis auf der Kachel plus macOS-Mitteilung. Geprüft wird nur in Claude-Sitzungen; während eine VA bedient, nicht (der Bildschirmtext von Instagram braucht Sekunden und hielt die Eingaben fest). Erst nach "Clear" plant Claude wieder.
- Likes zählen als Doppeltipp, Kommentare als gesendeter Text oder Enter beim direkten Tippen.

## Grenzen

- Etwa 0,5 s Latenz je Tipp, das ist die Grundlatenz von XCTest.
- Last je Gerät am Mac: etwa 60 MB RAM für go-ios plus Stream, bei 10 Geräten grob 1 GB und ein Viertel eines Kerns, plus Browser.
- Der Tunnel-Dienst von go-ios mit mehreren Geräten gleichzeitig ist hier nur mit einem Gerät getestet.
