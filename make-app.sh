#!/bin/zsh
# Nur Entwicklungs-Mac. Baut phone-lab.app (Doppelklick installiert oder aktualisiert), signiert und beglaubigt sie,
# wenn ein Developer-ID-Zertifikat und Zugangsdaten in .env vorhanden sind, und legt phone-lab.app.zip auf den Schreibtisch.
set -e
DIR=$(cd "$(dirname "$0")" && pwd); cd "$DIR"
[[ -d wda/WebDriverAgentRunner-Runner.app ]] || { echo "wda/ fehlt, erst ./build-wda.sh"; exit 1; }
[[ -x bin/node && -x bin/ios ]] || { echo "bin/ fehlt, erst ./make-package.sh"; exit 1; }
[[ -f .env ]] && set -a && source .env && set +a

# Version hochzählen: Datum plus Zähler
TODAY=$(date +%Y.%m.%d); OLD=$(cat VERSION 2>/dev/null || echo "")
if [[ "$OLD" == "$TODAY-"* ]]; then N=$(( ${OLD##*-} + 1 )); else N=1; fi
echo "$TODAY-$N" > VERSION; VER=$(cat VERSION); echo "Version $VER"

APP=/tmp/phone-lab-app-build/phone-lab.app; rm -rf /tmp/phone-lab-app-build; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/payload"
P="$APP/Contents/Resources/payload"
# Programmdateien. Keine Benutzer, keine Logs, keine Schlüssel, keine Pairings.
cp VERSION server.js index.html usbmux.js plist.js add-device.js user.js setup.sh install-launchd.sh smoke.sh Start.command devices.json README.md BRIEF.md .gitignore "$P/"
mkdir -p "$P/bin"; cp bin/node bin/ios "$P/bin/"
# WDA und Entwicklerbilder als Zip, damit die Beglaubigung die iOS-Binärdateien nicht prüft
(cd "$DIR" && ditto -c -k wda "$P/wda.zip" && ditto -c -k devimages "$P/devimages.zip")

cat > "$APP/Contents/MacOS/phone-lab" <<'L'
#!/bin/zsh
# Startprogramm der App: installiert phone-lab oder aktualisiert eine bestehende Installation.
P="$(cd "$(dirname "$0")/../Resources/payload" && pwd)"
VER=$(cat "$P/VERSION")
# Zielordner: bestehende Installation weiterverwenden, sonst Benutzerordner
D="${PHONELAB_DIR:-}"
if [[ -z "$D" ]]; then
  for c in ~/phone-lab ~/Desktop/phone-lab; do [[ -f "$c/users.json" ]] && D="$c" && break; done
  [[ -z "$D" ]] && D=~/phone-lab
fi
mkdir -p "$D"
# Sicherung der alten Programmdateien für einen Rückschritt
[[ -f "$D/VERSION" ]] && rm -rf "$D.vorher" && rsync -a --exclude logs --exclude users.json "$D/" "$D.vorher/"
# Programmdateien ersetzen, Benutzer, Logs, Schlüssel und Pairings bleiben
rsync -a --exclude users.json --exclude settings.json --exclude logs --exclude .env --exclude selfIdentity.plist --exclude wda.zip --exclude devimages.zip "$P/" "$D/"
rm -rf "$D/wda" "$D/devimages"; ditto -x -k "$P/wda.zip" "$D/wda"; ditto -x -k "$P/devimages.zip" "$D/devimages"
chmod +x "$D"/*.sh "$D"/*.command "$D"/bin/* "$D"/*.js
xattr -dr com.apple.quarantine "$D" 2>/dev/null || true
# Einrichtung oder Neustart im Terminal, damit man sieht, was passiert
if [[ -n "$PHONELAB_DIR" ]]; then echo "installiert nach $D, Version $VER"; exit 0; fi
osascript -e "tell application \"Terminal\" to do script \"cd '$D' && ./setup.sh; echo; echo 'phone-lab Version $VER'\"" -e 'tell application "Terminal" to activate' >/dev/null
L
chmod +x "$APP/Contents/MacOS/phone-lab"
cat > "$APP/Contents/Info.plist" <<I
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>phone-lab</string>
  <key>CFBundleDisplayName</key><string>phone-lab</string>
  <key>CFBundleIdentifier</key><string>com.cansap.phonelab.installer</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleExecutable</key><string>phone-lab</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHumanReadableCopyright</key><string>phone-lab</string>
</dict></plist>
I

# Signieren und beglaubigen, wenn möglich
ID=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
if [[ -n "$ID" ]]; then
  echo "Signiere mit: $ID"
  for b in "$P/bin/node" "$P/bin/ios"; do codesign --force --options runtime --timestamp --sign "$ID" "$b"; done
  codesign --force --options runtime --timestamp --sign "$ID" "$APP"
  codesign --verify --deep --strict "$APP" && echo "Signatur ok"
  if [[ -n "$NOTARY_APPLE_ID" && -n "$NOTARY_PASSWORD" && -n "$NOTARY_TEAM_ID" ]]; then
    ditto -c -k --keepParent "$APP" /tmp/phone-lab-app-build/notarize.zip
    echo "Beglaubigung bei Apple (einige Minuten) ..."
    xcrun notarytool submit /tmp/phone-lab-app-build/notarize.zip --apple-id "$NOTARY_APPLE_ID" --password "$NOTARY_PASSWORD" --team-id "$NOTARY_TEAM_ID" --wait 2>&1 | grep -E 'status|id:' | head -4
    xcrun stapler staple "$APP" && echo "Beglaubigung angeheftet"
  else
    echo "HINWEIS: keine Beglaubigungsdaten in .env (NOTARY_APPLE_ID, NOTARY_PASSWORD, NOTARY_TEAM_ID), App ist signiert, aber nicht beglaubigt."
  fi
else
  echo "HINWEIS: kein Developer-ID-Zertifikat, App ist unsigniert. Empfänger muss einmal: xattr -dr com.apple.quarantine phone-lab.app"
fi
OUT=~/Desktop/phone-lab.app.zip; rm -f "$OUT"; ditto -c -k --keepParent "$APP" "$OUT"
git -C "$DIR" add VERSION >/dev/null 2>&1 || true
echo "App: $OUT ($(du -h "$OUT" | cut -f1)), Version $VER"
