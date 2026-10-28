#!/usr/bin/env node
// Nimmt alle per USB angesteckten iPhones, die noch nicht in devices.json stehen, dort auf.
// Vergibt die nächste freie Nummer und die Ports 810N / 910N. Zeigt den Stand des Entwicklermodus.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const usbmux = require('./usbmux');

const ROOT = __dirname;
const IOS = fs.existsSync(path.join(ROOT, 'bin', 'ios')) ? path.join(ROOT, 'bin', 'ios') : 'ios';
const ios = args => { const r = spawnSync(IOS, args, { cwd: ROOT, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
const lastJson = s => { const lines = s.trim().split('\n').filter(l => l.startsWith('{')); try { return JSON.parse(lines[lines.length - 1]); } catch { return {}; } };

(async () => {
  const file = path.join(ROOT, 'devices.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const known = new Set(cfg.devices.map(d => d.udid));
  const found = await usbmux.listDevices();
  if (!found.length) { console.log('kein iPhone per USB gefunden'); return; }
  let added = 0;
  for (const { udid } of found) {
    const info = lastJson(ios(['info', '--udid=' + udid]));
    const name = info.DeviceName || '?', ver = info.ProductVersion || '?';
    const dm = lastJson(ios(['devmode', 'get', '--udid=' + udid]));
    const devmode = dm.enabled === true || /enabled.*true/i.test(JSON.stringify(dm)) ? 'an' : 'AUS';
    if (known.has(udid)) { console.log(`bekannt: ${cfg.devices.find(d => d.udid === udid).name} = ${udid} (${name}, iOS ${ver}), Entwicklermodus ${devmode}`); }
    else {
      const n = Math.max(0, ...cfg.devices.map(d => d.id)) + 1;
      cfg.devices.push({ id: n, name: `Handy ${n}`, udid, wda_port: 8100 + n, mjpeg_port: 9100 + n });
      added++; console.log(`neu: Handy ${n} = ${udid} (${name}, iOS ${ver}), Entwicklermodus ${devmode}`);
    }
    if (devmode === 'AUS') {
      ios(['devmode', 'reveal', '--udid=' + udid]);
      console.log(`  -> Auf "${name}": Einstellungen > Datenschutz und Sicherheit > Entwicklermodus einschalten (Schalter ist jetzt sichtbar), Neustart bestätigen.`);
    }
  }
  if (added) {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`${added} Gerät(e) in devices.json aufgenommen.`);
    if (!fs.existsSync(path.join(ROOT, 'wda'))) console.log('Hinweis: Neue Geräte müssen ins Signaturprofil, dazu auf dem Mac mit Xcode ./build-wda.sh ausführen.');
  }
})();
