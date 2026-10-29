#!/bin/zsh
# Startprogramm von phone-lab.app. Läuft bei jedem Doppelklick: richtet den Dienst ein (oder erneuert ihn nach einem Update),
# legt beim ersten Mal einen Admin an, startet die Tailscale-Freigabe und öffnet das Dashboard. Daten liegen unter
# ~/Library/Application Support/phone-lab und bleiben beim Ersetzen der App erhalten.
APP=$(cd "$(dirname "$0")/../.." && pwd); R="$APP/Contents/Resources/app"; VER=$(cat "$R/VERSION")
say() { osascript -e "display dialog \"$1\" with title \"phone-lab\" buttons {\"OK\"} default button 1" >/dev/null 2>&1; }
case "$APP" in /Volumes/*) say "Please drag phone-lab into the Applications folder first, then open it from there."; exit 0;; esac

DATA="${PHONELAB_DATA:-$HOME/Library/Application Support/phone-lab}"; mkdir -p "$DATA/logs"; export PHONELAB_DATA="$DATA"
# Umzug von einer älteren Installation (Ordner phone-lab mit users.json)
if [[ ! -f "$DATA/users.json" ]]; then
  for OLD in ~/phone-lab ~/Desktop/phone-lab; do
    if [[ -f "$OLD/users.json" ]]; then cp "$OLD/users.json" "$DATA/"; [[ -f "$OLD/settings.json" ]] && cp "$OLD/settings.json" "$DATA/"; [[ -d "$OLD/logs" ]] && cp -R "$OLD/logs/." "$DATA/logs/"; break; fi
  done
fi
# Erster Start: Admin anlegen
if [[ ! -f "$DATA/users.json" ]]; then
  NAME=$(osascript -e 'text returned of (display dialog "Welcome to phone-lab. Choose a username for the admin:" default answer "admin" with title "phone-lab")' 2>/dev/null) || exit 0
  for i in 1 2 3; do "$R/bin/node" "$R/user.js" add "$NAME" --admin >> "$DATA/logs/app.log" 2>&1 && break; say "Password must have at least 10 characters and match twice. Try again."; done
  [[ -f "$DATA/users.json" ]] || { say "No admin created. Open phone-lab again to retry."; exit 0; }
fi

if [[ -n "$PHONELAB_NO_LAUNCHD" ]]; then echo "ready: $DATA, version $VER"; exit 0; fi
# Dienst: Autostart nach Login, Mac schläft nicht, Neustart bei Absturz
PL=~/Library/LaunchAgents/com.phonelab.server.plist; mkdir -p ~/Library/LaunchAgents
cat > "$PL" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.phonelab.server</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-is</string><string>$R/bin/node</string><string>$R/server.js</string></array>
  <key>WorkingDirectory</key><string>$DATA</string>
  <key>EnvironmentVariables</key><dict><key>PHONELAB_DATA</key><string>$DATA</string><key>HOME</key><string>$HOME</string><key>PATH</key><string>/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/logs/server.log</string><key>StandardErrorPath</key><string>$DATA/logs/server.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/com.phonelab.server" >/dev/null 2>&1; sleep 1
launchctl bootstrap "gui/$(id -u)" "$PL" >> "$DATA/logs/app.log" 2>&1
# Warmup-Dienst: eigener Prozess, spricht den Server nur über dessen Befehle an (Dienst-Token in $DATA/service.token)
WL=~/Library/LaunchAgents/com.phonelab.warmup.plist
cat > "$WL" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.phonelab.warmup</string>
  <key>ProgramArguments</key><array><string>$R/bin/node</string><string>$R/warmup.js</string></array>
  <key>WorkingDirectory</key><string>$DATA</string>
  <key>EnvironmentVariables</key><dict><key>PHONELAB_DATA</key><string>$DATA</string><key>HOME</key><string>$HOME</string><key>PATH</key><string>/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/logs/warmup.log</string><key>StandardErrorPath</key><string>$DATA/logs/warmup.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/com.phonelab.warmup" >/dev/null 2>&1; sleep 1
launchctl bootstrap "gui/$(id -u)" "$WL" >> "$DATA/logs/app.log" 2>&1
# Tailscale-Freigabe, falls Tailscale da ist und noch nichts freigegeben wurde
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [[ -x "$TS" ]] && "$TS" serve status 2>&1 | grep -q "No serve config"; then ("$TS" serve --bg 3000 >> "$DATA/logs/app.log" 2>&1 &); fi
for i in {1..40}; do curl -s -o /dev/null http://127.0.0.1:3000/ && break; sleep 1; done
# Dashboard im eigenen Fenster, wenn phone-lab Desk installiert ist, sonst im Browser
if [[ -d "/Applications/phone-lab Desk.app" ]]; then open -a "phone-lab Desk"; else open "http://127.0.0.1:3000"; fi
osascript -e "display notification \"Version $VER is running. Phones connect over USB.\" with title \"phone-lab\"" >/dev/null 2>&1
