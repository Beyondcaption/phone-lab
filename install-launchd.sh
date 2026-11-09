#!/bin/zsh
# Richtet den Autostart des Servers nach dem Login ein (launchd) und verhindert den Ruhezustand (caffeinate).
# Pfade werden aus dem aktuellen Repo-Ordner und dem aktuellen Benutzer erzeugt, nichts ist fest verdrahtet.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
NODE="$DIR/bin/node"; [[ -x "$NODE" ]] || NODE=$(command -v node)
PLIST=~/Library/LaunchAgents/com.phonelab.server.plist
mkdir -p ~/Library/LaunchAgents "$DIR/logs"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.phonelab.server</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE</string><string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/server.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/com.phonelab.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Autostart eingerichtet: $PLIST"
# Warmup-Dienst als eigener Prozess (spricht den Server nur über dessen Befehle an)
WPLIST=~/Library/LaunchAgents/com.phonelab.warmup.plist
cat > "$WPLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.phonelab.warmup</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/warmup.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/warmup.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/warmup.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/com.phonelab.warmup" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$WPLIST"
echo "Warmup-Dienst eingerichtet: $WPLIST"
echo "Steuern:  launchctl kickstart -k gui/$(id -u)/com.phonelab.server   (Neustart)"
echo "          launchctl bootout gui/$(id -u)/com.phonelab.server        (Stoppen)"
