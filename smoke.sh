#!/bin/zsh
# Rauchtest gegen laufenden Server: Status, Instagram, wischen, tippen, Home. Bricht beim ersten Fehler ab.
set -e
B=http://127.0.0.1:3000
J=$(mktemp); trap 'rm -f $J' EXIT
# Anmeldung: SMOKE_USER und SMOKE_PW setzen, z. B. SMOKE_USER=chef SMOKE_PW=... H=3 ./smoke.sh
curl -s -c $J -o /dev/null -w '%{http_code}' -X POST $B/login --data-urlencode "name=$SMOKE_USER" --data-urlencode "pw=$SMOKE_PW" | grep -q 303 || { echo "Login fehlgeschlagen (SMOKE_USER/SMOKE_PW setzen)"; exit 1; }
c() { out=$(curl -s -b $J -X POST "$B/cmd/${H:-1}/$1" -H 'Content-Type: application/json' -d "${2:-{\}}"); echo "$1: $out"; [[ "$out" == *'"ok":true'* ]]; }
curl -s -b $J $B/devices | grep -q "\"id\":${H:-1},\"name\":\"[^\"]*\",\"ready\":true" || { echo "WDA nicht bereit"; exit 1; }
c instagram; sleep 3
c swipe '{"path":[{"x":0.5,"y":0.75,"t":0},{"x":0.5,"y":0.5,"t":150},{"x":0.5,"y":0.3,"t":300}]}'; sleep 1
c tap '{"x":0.5,"y":0.02}'; sleep 1
c home
echo "Rauchtest ok"
