# phone-lab

Steuert iPhones per USB vom Mac aus über eine lokale Kachel-Seite. Projektbrief: BRIEF.md.

## Dateien

- server.js: Node-Server ohne Zusatzpakete. Startet WDA je Gerät, überwacht es, reicht den Stream durch, nimmt Eingaben an. Nur 127.0.0.1:3000.
- index.html: Kachel-Seite.
- wda-start.sh: Startet WebDriverAgent auf einem iPhone plus Portweiterleitung über USB.
- devices.json: Geräte (UDID, Ports), Apple-Team-ID, Bundle-ID von WDA.
- smoke.sh: Rauchtest gegen den laufenden Server.
- setup.sh: Prüft und installiert alles auf einem frischen Mac, fragt vor jeder Installation.

## Umzug auf einen anderen Mac

1. Repo kopieren (git clone von diesem Mac, USB-Stick oder AirDrop; logs/ und .env nicht mitnehmen).
2. Auf dem neuen Mac `./setup.sh` ausführen und die Punkte abarbeiten, die FEHLT zeigen.
3. In Xcode die Apple-ID anmelden. Gleiche Apple-ID wie bisher: team_id in devices.json bleibt. Andere Apple-ID: team_id in devices.json auf die neue Team-ID setzen (setup.sh zeigt sie).
4. Jedes iPhone einmal an den neuen Mac stecken und "Diesem Computer vertrauen" bestätigen. Entwicklermodus bleibt an.
5. `node server.js` starten. Beim ersten Start je iPhone baut Xcode WDA neu und lädt es aufs Gerät. Danach auf dem iPhone unter Einstellungen > Allgemein > VPN und Geräteverwaltung die Entwickler-App vertrauen (nötig, weil der neue Mac ein eigenes Signierzertifikat bekommt).
6. http://127.0.0.1:3000 öffnen.

Beim ersten Start auf einem neuen Mac muss WDA einmal gebaut werden. wda-start.sh nutzt test-without-building, deshalb vorher einmal bauen:

```
cd ~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination 'id=<UDID>' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<team_id> CODE_SIGN_IDENTITY="Apple Development" \
  PRODUCT_BUNDLE_IDENTIFIER=<wda_bundle_id> build-for-testing
```

## Bedienung der Kachel

- Klick = tippen. Shift+Klick = Doppeltipp (Like). Linke Taste gedrückt ziehen = wischen entlang der Mausspur.
- Textfeld + Enter tippt in das Feld, das auf dem iPhone den Fokus hat.
- Knöpfe: Home, Instagram, Groß.

## Grenzen

- Kostenloses Apple-Konto: Signatur läuft nach 7 Tagen ab, WDA muss dann neu gebaut werden.
- Etwa 0,5 s Latenz je Tipp, das ist die Grundlatenz von XCTest.
