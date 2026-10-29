#!/usr/bin/env node
// Vorschau ohne iPhone: fake WDA + Server mit Beispieldaten, angemeldet als "admin" (nur Testbetrieb).
// Aufruf: node test/demo.js   dann http://127.0.0.1:3000 öffnen. Strg+C beendet.
// Beispieldaten (zum Ersetzen, nicht echt): Labels @demo_*, Warmup-Starts, ein paar VA-Aktionen von "maria".
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'phonelab-demo-'));
const day = n => { const d = new Date(Date.now() - n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mk = (name, admin) => { const salt = crypto.randomBytes(16); return { name, salt: salt.toString('hex'), hash: crypto.scryptSync('demo-password-1', salt, 32).toString('hex'), admin, devices: 'all' }; };
fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify({ users: [mk('admin', true), mk('maria', false), mk('jonas', false)] }));
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  snippets: { global: ['so good', 'love this edit'], phone: {} }, notes: { 4: 'New SIM since Monday, go slow' },
  labels: { 1: '@demo_kuro', 2: '@demo_rubi', 3: '@demo_lina', 4: '@demo_sofi', 5: '@demo_moxy' }, targets: { maria: { texts: 6, minutes: 120 } } }));
fs.writeFileSync(path.join(DATA, 'warmup.json'), JSON.stringify({
  window: ['00:00', '23:59'], phones: { 1: { start: day(4), niche: 'Gaming, Cosplay' }, 2: { start: day(0), niche: 'Anime' }, 3: { start: day(9), niche: 'Techno, Nightlife' }, 4: { start: day(2), niche: 'Fitness' } },
  alerts: { 3: { at: new Date().toISOString(), reason: 'stop word on screen while maria was working', by: 'watch' } } }));
// Zugriffslog: maria hat heute auf Handy 1 gearbeitet (Likes und Kommentare), jonas gestern
const lines = [], at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
for (let i = 0; i < 40; i++) lines.push(`${at(90 - i)} maria 100.64.0.2 Phone 1 ${i % 9 === 0 ? 'doubletap' : i % 13 === 0 ? 'text (12 chars)' : 'swipe'}`);
for (let i = 0; i < 30; i++) lines.push(`${at(1500 - i * 2)} jonas 100.64.0.3 Phone 4 ${i % 7 === 0 ? 'doubletap' : 'swipe'}`);
for (let d = 2; d < 12; d++) for (let i = 0; i < 20 + d * 3; i++) lines.push(`${at(d * 1440 - i * 2)} maria 100.64.0.2 Phone 2 swipe`);
fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'logs', 'zugriff.log'), lines.sort().join('\n') + '\n');

const run = (file, env) => spawn(process.execPath, [path.join(ROOT, file)], { env: { ...process.env, ...env }, stdio: 'inherit' });
const procs = [run('test/fake-wda.js', {}), run('server.js', { PHONELAB_FAKE: '1', PHONELAB_DATA: DATA, PHONELAB_AUTOLOGIN: 'admin', ANTHROPIC_API_KEY: '' })];
process.on('SIGINT', () => { procs.forEach(p => p.kill()); process.exit(0); });
process.on('SIGTERM', () => { procs.forEach(p => p.kill()); process.exit(0); });
console.log('Daten in', DATA);
