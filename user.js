#!/usr/bin/env node
// Benutzer für die Kachel-Seite verwalten. Passwörter werden nur als Hash gespeichert (scrypt), nie im Klartext.
//   node user.js add <name> [--admin] [--handys 1,2,3]    Passwort wird abgefragt, nicht angezeigt. Ohne --handys: sieht alle Handys
//   node user.js handys <name> 1,2,3|alle                  Zuteilung ändern
//   node user.js list
//   node user.js remove <name>
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILE = path.join(__dirname, 'users.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { users: [] }; } };
const save = db => fs.writeFileSync(FILE, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
const [cmd, name, ...rest] = process.argv.slice(2);
const db = load();
// Passwort ohne Anzeige: im Terminal direkt, sonst (z. B. aus Claude Code) über einen macOS-Dialog
const askHidden = q => new Promise(r => {
  if (!process.stdin.isTTY) {
    const out = require('child_process').spawnSync('osascript', ['-e', `text returned of (display dialog ${JSON.stringify(q)} default answer "" with hidden answer with title "phone-lab")`], { encoding: 'utf8' });
    if (out.status !== 0) { console.error('abgebrochen'); process.exit(1); }
    return r(out.stdout.replace(/\n$/, ''));
  }
  process.stdout.write(q); const si = process.stdin; si.setRawMode(true); si.resume(); let s = '';
  si.on('data', c => { c = c.toString(); if (c === '\r' || c === '\n') { si.setRawMode(false); si.pause(); process.stdout.write('\n'); r(s); } else if (c === '\u0003') process.exit(1); else if (c === '\u007f') s = s.slice(0, -1); else s += c; });
});
const parseIds = v => !v || v === 'alle' ? 'all' : v.split(',').map(Number).filter(Boolean);
(async () => {
  if (cmd === 'add' && name) {
    const n = name.toLowerCase();
    if (db.users.some(u => u.name === n)) return console.error('gibt es schon');
    const pw = await askHidden(`Passwort für ${n}: `);
    if (pw.length < 10) return console.error('mindestens 10 Zeichen');
    if (pw !== await askHidden('Nochmal: ')) return console.error('stimmt nicht überein');
    const salt = crypto.randomBytes(16);
    db.users.push({ name: n, salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex'), admin: rest.includes('--admin'), devices: rest.includes('--handys') ? parseIds(rest[rest.indexOf('--handys') + 1]) : 'all' });
    save(db); console.log(`angelegt: ${n}${rest.includes('--admin') ? ' (Admin, sieht alle Handys)' : ''}`);
  } else if (cmd === 'handys' && name) {
    const u = db.users.find(x => x.name === name.toLowerCase()); if (!u) return console.error('unbekannt');
    u.devices = parseIds(rest[0]); save(db); console.log(`${u.name}: Handys ${u.devices === 'all' ? 'alle' : u.devices.join(', ') || 'keine'}`);
  } else if (cmd === 'remove' && name) {
    db.users = db.users.filter(u => u.name !== name.toLowerCase()); save(db); console.log('entfernt');
  } else if (cmd === 'list') {
    for (const u of db.users) console.log(`${u.name}${u.admin ? ' (Admin)' : ''}: Handys ${u.admin || u.devices === 'all' ? 'alle' : u.devices.join(', ') || 'keine'}`);
  } else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 6).join('\n'));
})();
