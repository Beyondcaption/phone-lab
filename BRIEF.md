# phone-lab: Fernsteuerung von iPhones über USB am Mac

## Ziel
10 iPhone SE (2022) per USB am Mac. Live-Bild, tippen, wischen, Text, Home über eine Kachel-Seite im Browser.
Liken/Kommentieren macht nur ein Mensch (VA) über die Kachel-Seite. Posten läuft über Metricool, nicht hier.

## Harte Regeln
- iPhones nur über eigene SIM. WLAN, Bluetooth, Hotspot NIE einschalten. Steuerung nur über USB (usbmuxd).
- Keine automatischen Likes, Kommentare, Follows, DMs, Profilbesuche.
- Kein Jailbreak, keine iOS-Manipulation.
- Vor jeder Installation Rückfrage.
- Keine Geheimnisse im Chat, Repo oder Logs. Nur .env (in .gitignore).
- Am Ende jeder Phase anhalten, echten Test zeigen, auf Go warten.
- Lokales git, kein Push ohne Go.
- Antworten auf Deutsch mit Umlauten, keine Gedankenstriche.

## Technik
- WebDriverAgent (XCUITest-Runner) je iPhone, über Appium XCUITest-Treiber oder xcodebuild + iproxy.
- Ports je Gerät: WDA 8101-8110, MJPEG 9101-9110, Zuordnung per UDID in Konfigdatei.
- Eingaben über WDA-HTTP-API. Instagram: com.burbn.instagram.
- Server Node.js, Oberfläche schlichte Web-Seite.

## Phasen
0 Bestandsaufnahme
1 Ein iPhone steuern (Screenshot, Instagram öffnen, wischen, Home; WLAN aus bestätigen)
2 Kachel-Seite lokal (127.0.0.1), Koordinaten, Status, WDA-Neustart
3 Alle 10 Geräte, launchd-Autostart, kein Ruhezustand, Lastmessung
4 Freigabe für VA (Tailscale oder Cloudflare Tunnel), Login je VA, Sperre je Handy, Protokoll, nur minimale Endpunkte, iPhone-Absicherungs-Checkliste, FileVault/Firewall
5 Optional, nur nach Go, nur Test-Account: Scroll-Sitzungen durch Claude (nur wischen, Stopp bei Captcha/Hinweis, Protokoll)
