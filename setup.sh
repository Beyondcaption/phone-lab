#!/bin/zsh
# Einrichtung auf dem Betriebs-Mac. Braucht kein Xcode, kein Homebrew: Node und go-ios liegen in bin/, WDA in wda/.
# Prüft alles, nimmt angesteckte iPhones auf, richtet den Autostart ein. Beliebig oft ausführbar.
cd "$(dirname "$0")"; mkdir -p logs
ok() { echo "  ok    $1"; }; fehlt() { echo "  FEHLT $1"; }
ask() { read -q "r?$1 [y/N] "; echo; [[ $r == y ]]; }

echo "== Programme =="
NODE=./bin/node; [[ -x $NODE ]] || NODE=$(command -v node)
[[ -n "$NODE" ]] && ok "node $($NODE -v)" || { fehlt "bin/node (Paket unvollständig)"; exit 1; }
IOS=./bin/ios; [[ -x $IOS ]] || IOS=$(command -v ios)
[[ -n "$IOS" ]] && ok "go-ios $($IOS version 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)" || { fehlt "bin/ios (Paket unvollständig)"; exit 1; }
[[ -d wda/WebDriverAgentRunner-Runner.app ]] && ok "WDA-App (signiert bis $(security cms -D -i wda/WebDriverAgentRunner-Runner.app/embedded.mobileprovision 2>/dev/null | grep -A1 ExpirationDate | tail -1 | sed 's/.*<date>//; s/T.*//'))" || { fehlt "wda/ (auf dem Mac mit Xcode ./build-wda.sh ausführen)"; exit 1; }
xattr -dr com.apple.quarantine bin wda 2>/dev/null || true

echo "== iPhones per USB =="
$NODE add-device.js

echo "== Autostart (launchd) + Schlafsperre =="
if launchctl print "gui/$(id -u)/com.phonelab.server" >/dev/null 2>&1; then
  ok "Autostart eingerichtet"; ask "Server jetzt neu starten (nimmt neue Geräte auf)?" && launchctl kickstart -k "gui/$(id -u)/com.phonelab.server"
else
  ask "Autostart nach Login einrichten und Server starten?" && ./install-launchd.sh
fi
echo
echo "Kachel-Seite: http://127.0.0.1:3000   Logs: logs/server.log und logs/handy-N.log"
echo "Auf jedem neuen iPhone einmal: Einstellungen > Allgemein > VPN und Geräteverwaltung > Entwickler-App vertrauen."
echo "Neue iPhones später: anstecken, vertrauen, dann ./setup.sh nochmal. Neue Geräte brauchen einmal ./build-wda.sh auf dem Mac mit Xcode."
