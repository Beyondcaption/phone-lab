#!/bin/zsh
# Nur auf dem Entwicklungs-Mac. Packt alles, was der Betriebs-Mac braucht, in ein Archiv auf dem Schreibtisch:
# Server, Kachel-Seite, go-ios, Node (offizielle Version von nodejs.org, für Apple Silicon und Intel), WDA-App, Entwicklerbilder.
set -e
DIR=$(cd "$(dirname "$0")" && pwd); cd "$DIR"
[[ -d wda/WebDriverAgentRunner-Runner.app ]] || { echo "wda/ fehlt, erst ./build-wda.sh"; exit 1; }
mkdir -p bin
NODE_VER=$(node -p "process.version")
for ARCH in arm64 x64; do
  if [[ ! -x bin/node-$ARCH ]]; then
    echo "Lade Node $NODE_VER für $ARCH von nodejs.org ..."
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$ARCH.tar.gz" | tar -xz -C bin --strip-components=2 "node-$NODE_VER-darwin-$ARCH/bin/node"
    mv bin/node "bin/node-$ARCH"
  fi
done
lipo -create bin/node-arm64 bin/node-x64 -output bin/node 2>/dev/null || cp bin/node-arm64 bin/node
cp "$(readlink -f "$(command -v ios)")" bin/ios
chmod +x bin/*
OUT=~/Desktop/phone-lab-paket.tar.gz
tar --exclude='phone-lab/logs' --exclude='phone-lab/.gstack' --exclude='phone-lab/.env' --exclude='phone-lab/.git' --exclude='phone-lab/selfIdentity.plist' --exclude='phone-lab/users.json' \
    --exclude='phone-lab/bin/node-*' -czf "$OUT" -C "$DIR/.." phone-lab
echo "Paket: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Auf dem Betriebs-Mac: Archiv in den Benutzerordner, doppelklicken (entpackt), dann im Ordner phone-lab auf 'Start.command' doppelklicken."
