#!/bin/zsh
# Nimmt alle per USB angesteckten iPhones, die noch nicht in devices.json stehen, dort auf.
# Vergibt die nächste freie Nummer und die Ports 810N / 910N. Danach Server neu starten.
cd "$(dirname "$0")"
python3 - <<'PY'
import json, subprocess
cfg = json.load(open('devices.json'))
known = {d['udid'] for d in cfg['devices']}
try: udids = subprocess.run(['idevice_id', '-l'], capture_output=True, text=True).stdout.split()
except FileNotFoundError: raise SystemExit('idevice_id fehlt, erst ./setup.sh')
if not udids: raise SystemExit('kein iPhone per USB gefunden')
def info(u, k): return subprocess.run(['ideviceinfo', '-u', u, '-k', k], capture_output=True, text=True).stdout.strip()
devmode = subprocess.run(['idevicedevmodectl', 'list'], capture_output=True, text=True).stdout
new = []
for u in udids:
    if u in known: print(f'bekannt: {u} ({info(u,"DeviceName")})'); continue
    n = max([d['id'] for d in cfg['devices']] + [0]) + 1
    d = {'id': n, 'name': f'Handy {n}', 'udid': u, 'wda_port': 8100 + n, 'mjpeg_port': 9100 + n}
    cfg['devices'].append(d); new.append(d)
    dm = 'an' if f'{u}' in devmode and 'enabled' in [l for l in devmode.splitlines() if u in l][0] else 'AUS'
    print(f'neu: Handy {n} = {u} ({info(u,"DeviceName")}, iOS {info(u,"ProductVersion")}), Entwicklermodus {dm}')
if new:
    json.dump(cfg, open('devices.json', 'w'), indent=2, ensure_ascii=False); open('devices.json', 'a').write('\n')
    print(f'{len(new)} Gerät(e) in devices.json aufgenommen. Jetzt: Server neu starten (launchctl kickstart -k gui/$(id -u)/com.phonelab.server oder node server.js).')
    print('Auf jedem neuen iPhone nach dem ersten Start: Einstellungen > Allgemein > VPN und Geräteverwaltung > Entwickler-App vertrauen.')
PY
