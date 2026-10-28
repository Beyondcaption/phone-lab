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

## Zugriff für VAs (Phase 4)

Der Server lauscht weiterhin nur auf 127.0.0.1. Nach außen kommt die Seite über Tailscale Serve, das auf 127.0.0.1:3000
weiterleitet. Der Mac selbst ist aus dem Internet nie erreichbar, die Seite nur für Mitglieder des Tailnets.

### Tailscale einrichten (einmalig je Mac)

1. Tailscale-App installieren und mit dem eigenen Konto anmelden.
2. Freigabe: `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --http=80 3000` (bleibt nach Neustart erhalten).
   Adresse im Tailnet: http://<mac-name>.<tailnet>.ts.net, der Verkehr ist durch Tailscale verschlüsselt.
   Mit HTTPS-Zertifikaten im Tailnet (Admin-Konsole > DNS > HTTPS Certificates) geht stattdessen `serve --bg 3000` und https://...
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

1. Zuerst WDA installieren und der Entwickler-App vertrauen (passiert beim ersten Start des Servers). Danach erst sperren,
   denn das Verbot "Apps installieren" blockiert auch die WDA-Installation.
2. Kein Mail-Konto auf dem Handy (Einstellungen > Mail > Accounts). Instagram-2FA nicht auf demselben Handy.
3. Bildschirmzeit mit eigenem Code: Einstellungen > Bildschirmzeit > Bildschirmzeit-Code festlegen (nicht der Geräte-Code).
4. Beschränkungen > Käufe im iTunes & App Store: Installieren "Nicht erlauben", Apps löschen "Nicht erlauben".
5. Beschränkungen > Änderungen zulassen: Code-Änderungen "Nicht erlauben", Account-Änderungen "Nicht erlauben".
6. Beschränkungen > Erlaubte Apps: nur das Nötige (Instagram, Einstellungen bleibt). WDA zählt nicht als App in dieser Liste und läuft weiter.
7. WLAN und Bluetooth aus lassen; Beschränkungen > Änderungen zulassen > Mobilfunkdaten-Änderungen "Nicht erlauben".

Was WDA braucht und von den Sperren nicht berührt wird: Entwicklermodus (bleibt an), das Vertrauen der Entwickler-App, USB.
Einmal im Jahr (neue Signatur) muss "Installieren" kurz wieder erlaubt werden, dann neues Paket einspielen, dann wieder sperren.

### Mac

FileVault an, Firewall an (geprüft am 28.10.2026). Automatische Anmeldung nur, wenn der Mac physisch sicher steht.

## Bedienung der Kachel

- Klick = tippen. Shift+Klick = Doppeltipp (Like). Linke Taste gedrückt ziehen = wischen entlang der Mausspur, mit Leuchtspur.
- Textfeld + Enter tippt in das Feld, das auf dem iPhone den Fokus hat.
- Knöpfe: Home, Instagram, Groß.

## Grenzen

- Etwa 0,5 s Latenz je Tipp, das ist die Grundlatenz von XCTest.
- Last je Gerät am Mac: etwa 60 MB RAM für go-ios plus Stream, bei 10 Geräten grob 1 GB und ein Viertel eines Kerns, plus Browser.
- Der Tunnel-Dienst von go-ios mit mehreren Geräten gleichzeitig ist hier nur mit einem Gerät getestet.
