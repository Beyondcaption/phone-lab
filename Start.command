#!/bin/zsh
# Doppelklick im Finder: richtet alles ein (fragt nach) und öffnet die Kachel-Seite.
cd "$(dirname "$0")"
./setup.sh
sleep 3
open http://127.0.0.1:3000
echo; echo "Dieses Fenster kann geschlossen werden."
