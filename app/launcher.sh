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
    if [[ -f "$OLD/users.json" ]]; then
      cp "$OLD/users.json" "$DATA/"; [[ -f "$OLD/settings.json" ]] && cp "$OLD/settings.json" "$DATA/"; [[ -d "$OLD/logs" ]] && cp -R "$OLD/logs/." "$DATA/logs/"
      # Pairing zu den iPhones und Entwicklerbilder mitnehmen, sonst fragen die Handys erneut nach Vertrauen
      [[ -f "$OLD/selfIdentity.plist" ]] && cp "$OLD/selfIdentity.plist" "$DATA/"; [[ -d "$OLD/devimages" && ! -d "$DATA/devimages" ]] && cp -R "$OLD/devimages" "$DATA/devimages"
      # alten Dienst aus dem Ordner beenden, die App übernimmt
      launchctl bootout "gui/$(id -u)/com.phonelab.server" >/dev/null 2>&1; pkill -f "$OLD/server.js" >/dev/null 2>&1
      break
    fi
  done
fi
# Erster Start: Admin anlegen
if [[ ! -f "$DATA/users.json" ]]; then
  NAME=$(osascript -e 'text returned of (display dialog "Welcome to phone-lab. Choose a username for the admin:" default answer "admin" with title "phone-lab")' 2>/dev/null) || exit 0
  for i in 1 2 3; do "$R/bin/node" "$R/user.js" add "$NAME" --admin >> "$DATA/logs/app.log" 2>&1 && break; say "Password must have at least 10 characters and match twice. Try again."; done
  [[ -f "$DATA/users.json" ]] || { say "No admin created. Open phone-lab again to retry."; exit 0; }
fi

if [[ -n "$PHONELAB_NO_LAUNCHD" ]]; then echo "ready: $DATA, version $VER"; exit 0; fi
# Fenster nur neu geöffnet, gleiche Version, beide Dienste antworten: nichts neu starten (sonst fliegen die VAs kurz raus)
if [[ -n "$PHONELAB_FROM_WINDOW" && "$(cat "$DATA/.installed-version" 2>/dev/null)" == "$VER" ]] \
   && curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/login && curl -s -o /dev/null --max-time 2 http://127.0.0.1:3001/; then
  exit 0
fi
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
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DATA/logs/server.log</string><key>StandardErrorPath</key><string>$DATA/logs/server.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/com.phonelab.server" >/dev/null 2>&1; sleep 1
# Was jetzt noch auf Port 3000 oder 3001 lauscht, ist eine alte Installation (Ordner, Terminal, Start.command):
# beenden, sonst bekommt der neue Dienst den Port nicht und das alte Dashboard bleibt sichtbar
for PID in $(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null) $(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null); do
  echo "$(date) beende alten Prozess $PID: $(ps -o command= -p $PID)" >> "$DATA/logs/app.log"; kill $PID 2>/dev/null
done
sleep 1
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
echo "$VER" > "$DATA/.installed-version"
# phone-lab Desk wird auf diesem Mac nicht mehr gebraucht (das Fenster ist jetzt in dieser App); VAs nutzen es weiter
# Tailscale-Freigabe, falls Tailscale da ist und noch nichts freigegeben wurde
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [[ -x "$TS" ]] && "$TS" serve status 2>&1 | grep -q "No serve config"; then ("$TS" serve --bg 3000 >> "$DATA/logs/app.log" 2>&1 &); fi
for i in {1..40}; do curl -s -o /dev/null http://127.0.0.1:3000/ && break; sleep 1; done
# Das Fenster der App zeigt das Dashboard selbst (PHONELAB_FROM_WINDOW). Nur ohne Fenster-App (Rückfall von make-app.sh):
# phone-lab Desk, sonst Browser
if [[ -z "$PHONELAB_FROM_WINDOW" ]]; then
  if [[ -d "/Applications/phone-lab Desk.app" ]]; then open -a "phone-lab Desk"; else open "http://127.0.0.1:3000"; fi
fi
osascript -e "display notification \"Version $VER is running. Phones connect over USB.\" with title \"phone-lab\"" >/dev/null 2>&1
