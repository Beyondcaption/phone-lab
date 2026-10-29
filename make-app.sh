#!/bin/zsh
# Nur Entwicklungs-Mac. Baut phone-lab.app (läuft direkt aus dem Programme-Ordner, Daten unter
# ~/Library/Application Support/phone-lab) und packt sie als DMG. Version zählt automatisch hoch.
# Mit --release wird das DMG als GitHub-Release hochgeladen.
set -e
DIR=$(cd "$(dirname "$0")" && pwd); cd "$DIR"
[[ -d wda/WebDriverAgentRunner-Runner.app ]] || { echo "wda/ fehlt, erst ./build-wda.sh"; exit 1; }
[[ -x bin/node && -x bin/ios ]] || { echo "bin/ fehlt, erst ./make-package.sh"; exit 1; }

TODAY=$(date +%Y.%m.%d); OLD=$(cat VERSION 2>/dev/null || echo "")
if [[ "$OLD" == "$TODAY-"* ]]; then N=$(( ${OLD##*-} + 1 )); else N=1; fi
echo "$TODAY-$N" > VERSION; VER=$(cat VERSION); echo "Version $VER"

B=/tmp/phone-lab-app-build; rm -rf "$B"; mkdir -p "$B"
APP="$B/phone-lab.app"; R="$APP/Contents/Resources/app"
mkdir -p "$APP/Contents/MacOS" "$R/bin"
cp VERSION server.js warmup.js index.html usbmux.js plist.js user.js devices.json README.md "$R/"
cp bin/node bin/ios "$R/bin/"; cp -R wda "$R/wda"; cp -R devimages "$R/devimages"
cp "$DIR/app/launcher.sh" "$APP/Contents/MacOS/phone-lab"; chmod +x "$APP/Contents/MacOS/phone-lab" "$R/bin/"*

# Symbol
if [[ ! -f "$DIR/app/phone-lab.icns" ]]; then
  swift "$DIR/app/icon.swift" "$B/icon.png" && mkdir -p "$B/icon.iconset" && for s in 16 32 64 128 256 512 1024; do sips -z $s $s "$B/icon.png" --out "$B/icon.iconset/icon_${s}x${s}.png" >/dev/null; done \
    && cp "$B/icon.iconset/icon_32x32.png" "$B/icon.iconset/icon_16x16@2x.png" && cp "$B/icon.iconset/icon_64x64.png" "$B/icon.iconset/icon_32x32@2x.png" \
    && cp "$B/icon.iconset/icon_256x256.png" "$B/icon.iconset/icon_128x128@2x.png" && cp "$B/icon.iconset/icon_512x512.png" "$B/icon.iconset/icon_256x256@2x.png" \
    && cp "$B/icon.iconset/icon_1024x1024.png" "$B/icon.iconset/icon_512x512@2x.png" && rm "$B/icon.iconset/icon_64x64.png" "$B/icon.iconset/icon_1024x1024.png" \
    && iconutil -c icns "$B/icon.iconset" -o "$DIR/app/phone-lab.icns" || echo "HINWEIS: Symbol konnte nicht erzeugt werden"
fi
[[ -f "$DIR/app/phone-lab.icns" ]] && cp "$DIR/app/phone-lab.icns" "$APP/Contents/Resources/phone-lab.icns"

cat > "$APP/Contents/Info.plist" <<I
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>phone-lab</string>
  <key>CFBundleDisplayName</key><string>phone-lab</string>
  <key>CFBundleIdentifier</key><string>com.cansap.phonelab</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleExecutable</key><string>phone-lab</string>
  <key>CFBundleIconFile</key><string>phone-lab</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
I

# DMG: App plus Verknüpfung auf Programme, zum Reinziehen
D="$B/dmg"; mkdir -p "$D"; cp -R "$APP" "$D/"; ln -s /Applications "$D/Applications"
OUT=~/Desktop/phone-lab-$VER.dmg; rm -f "$OUT"
hdiutil create -volname "phone-lab $VER" -srcfolder "$D" -ov -format UDZO "$OUT" >/dev/null
echo "DMG: $OUT ($(du -h "$OUT" | cut -f1))"

git -C "$DIR" add VERSION >/dev/null 2>&1 || true
if [[ "$1" == "--release" ]]; then
  gh release create "v$VER" "$OUT" --repo Beyondcaption/phone-lab --title "phone-lab $VER" --notes "${2:-Update $VER}" && echo "Release v$VER hochgeladen"
fi
