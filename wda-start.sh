#!/bin/zsh
# Startet WDA auf einem iPhone und leitet WDA- und MJPEG-Port über USB weiter.
# Aufruf: ./wda-start.sh <udid> <wda_port> <mjpeg_port>
set -e
UDID=$1; WDA_PORT=$2; MJPEG_PORT=$3
TEAM=$(python3 -c "import json;print(json.load(open('$(dirname $0)/devices.json'))['team_id'])")
BUNDLE=$(python3 -c "import json;print(json.load(open('$(dirname $0)/devices.json'))['wda_bundle_id'])")
WDA=~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
iproxy "$WDA_PORT:8100" -u "$UDID" &
iproxy "$MJPEG_PORT:9100" -u "$UDID" &
cd "$WDA"
exec xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination "id=$UDID" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" USE_PORT=8100 MJPEG_SERVER_PORT=9100 \
  test-without-building
