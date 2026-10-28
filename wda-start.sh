#!/bin/zsh
# Startet WDA auf einem iPhone und leitet WDA- und MJPEG-Port über USB weiter.
# Baut WDA vorher neu, wenn das Gerät noch nicht im Signaturprofil steht oder der Build älter als 6 Tage ist
# (kostenlose Apple-ID: Profil läuft nach 7 Tagen ab).
# Aufruf: ./wda-start.sh <udid> <wda_port> <mjpeg_port>
set -e
UDID=$1; WDA_PORT=$2; MJPEG_PORT=$3
DIR=$(cd "$(dirname "$0")" && pwd)
TEAM=$(python3 -c "import json;print(json.load(open('$DIR/devices.json'))['team_id'])")
BUNDLE=$(python3 -c "import json;print(json.load(open('$DIR/devices.json'))['wda_bundle_id'])")
WDA=~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
ARGS=(-project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination "id=$UDID" -allowProvisioningUpdates
      DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE"
      USE_PORT=8100 MJPEG_SERVER_PORT=9100)
cd "$WDA"
APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app 2>/dev/null | head -1)
needs_build() {
  [[ -z "$APP" ]] && { echo "WDA: noch nie gebaut"; return 0; }
  [[ -z "$(find "$APP" -maxdepth 0 -mtime -6)" ]] && { echo "WDA: Build älter als 6 Tage"; return 0; }
  security cms -D -i "$APP/embedded.mobileprovision" 2>/dev/null | grep -q "$UDID" || { echo "WDA: Gerät $UDID nicht im Profil"; return 0; }
  return 1
}
if needs_build; then
  echo "WDA: baue neu für $UDID ..."
  xcodebuild "${ARGS[@]}" build-for-testing | grep -E 'error:|BUILD' || true
fi
pkill -f "iproxy $WDA_PORT:" || true
pkill -f "iproxy $MJPEG_PORT:" || true
iproxy "$WDA_PORT:8100" -u "$UDID" &
iproxy "$MJPEG_PORT:9100" -u "$UDID" &
exec xcodebuild "${ARGS[@]}" test-without-building
