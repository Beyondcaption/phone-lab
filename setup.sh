#!/bin/zsh
# Richtet einen frischen Mac für phone-lab ein. Fragt vor jeder Installation. Mehrfach ausführbar.
set -e
cd "$(dirname "$0")"
ok() { echo "  ok   $1"; }; fehlt() { echo "  FEHLT $1"; }
ask() { read -q "r?$1 [y/N] "; echo; [[ $r == y ]]; }

echo "== Xcode =="
xcode-select -p >/dev/null 2>&1 && ok "Xcode: $(xcodebuild -version | head -1)" || { fehlt "Xcode aus dem App Store installieren, einmal öffnen, Lizenz bestätigen"; exit 1; }
xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 || { fehlt "Xcode einmal öffnen und Lizenz bestätigen (oder: sudo xcodebuild -runFirstLaunch)"; exit 1; }

echo "== Homebrew =="
command -v brew >/dev/null && ok "brew $(brew --version | head -1 | cut -d' ' -f2)" || { fehlt "Homebrew: https://brew.sh"; exit 1; }

echo "== libimobiledevice =="
command -v idevice_id >/dev/null && ok "libimobiledevice" || { ask "brew install libimobiledevice?" && brew install libimobiledevice; }

echo "== Node =="
command -v node >/dev/null && ok "node $(node -v)" || { ask "brew install node?" && brew install node; }

echo "== Appium + XCUITest-Treiber =="
command -v appium >/dev/null && ok "appium $(appium -v)" || { ask "npm install -g appium?" && npm install -g appium; }
appium driver list --installed 2>&1 | grep -q xcuitest && ok "xcuitest-Treiber" || { ask "appium driver install xcuitest?" && appium driver install xcuitest; }

echo "== Apple-ID in Xcode =="
TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | grep -m1 teamID | sed 's/.*= *//; s/[";]//g')
if [[ -n "$TEAM" ]]; then
  ok "Team $TEAM in Xcode"
  CUR=$(python3 -c "import json;print(json.load(open('devices.json'))['team_id'])")
  [[ "$TEAM" == "$CUR" ]] || echo "  HINWEIS team_id in devices.json ist $CUR, Xcode hat $TEAM. Anpassen, falls dieser Mac mit anderer Apple-ID signiert."
else
  fehlt "Xcode > Settings > Accounts > Plus > Apple-ID anmelden"
fi

echo "== iPhones per USB =="
./add-device.sh

echo "== Autostart (launchd) + Schlafsperre =="
if launchctl print "gui/$(id -u)/com.phonelab.server" >/dev/null 2>&1; then
  ok "Autostart eingerichtet"; ask "Server jetzt neu starten (nimmt neue Geräte auf)?" && launchctl kickstart -k "gui/$(id -u)/com.phonelab.server"
else
  ask "Autostart nach Login einrichten und Server starten?" && ./install-launchd.sh
fi
echo
echo "Fertig. Kachel-Seite: http://127.0.0.1:3000   Logs: logs/server.log und logs/handy-N.log"
echo "Neue iPhones später: anstecken, vertrauen, Entwicklermodus an, dann ./setup.sh nochmal."
