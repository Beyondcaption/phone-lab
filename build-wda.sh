#!/bin/zsh
# Nur auf einem Mac mit Xcode und angemeldeter Apple-ID. Baut WebDriverAgent, trägt alle iPhones aus devices.json
# ins Signaturprofil ein und legt die fertige App unter wda/ ab. Das Ergebnis wandert mit ins Paket.
# Jedes Gerät muss dafür einmal per USB angesteckt gewesen sein (Registrierung läuft über Xcode).
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}; [[ -x "$DIR/bin/node" ]] && NODE="$DIR/bin/node"
TEAM=$($NODE -p "require('$DIR/devices.json').team_id")
BUNDLE=$($NODE -p "require('$DIR/devices.json').wda_bundle_id")
UDIDS=($($NODE -p "require('$DIR/devices.json').devices.map(d=>d.udid).join(' ')"))
WDA=~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
[[ -d "$WDA" ]] || { echo "WebDriverAgent-Quellen fehlen: npm install -g appium && appium driver install xcuitest"; exit 1; }
cd "$WDA"
for U in $UDIDS; do
  echo "== Baue und registriere $U =="
  xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination "id=$U" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
    build-for-testing 2>&1 | grep -E 'error:|\*\* ' || true
done
APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app | head -1)
rm -rf "$DIR/wda"; mkdir -p "$DIR/wda"; cp -R "$APP" "$DIR/wda/"
echo "== Profil =="
security cms -D -i "$APP/embedded.mobileprovision" | grep -A1 ExpirationDate | tail -1 | sed 's/.*<date>/läuft ab: /; s/<.*//'
for U in $UDIDS; do security cms -D -i "$APP/embedded.mobileprovision" | grep -q "$U" && echo "  ok    $U" || echo "  FEHLT $U (Gerät war nicht angesteckt?)"; done
echo "WDA-App liegt in $DIR/wda/"
