#!/usr/bin/env node
// Spielt WDA und den MJPEG-Strom für alle Handys aus devices.json nach, für Tests ohne iPhone (Windows, CI).
// Jeder Eingabe-Aufruf dauert 150 ms wie ein echter XCTest-Aufruf. Zählt, ob Aufrufe parallel ankommen.
// FAKE_STOP=3 zeigt auf Handy 3 einen Sperrhinweis im Bildschirmtext. Stats: GET http://127.0.0.1:<wda_port>/fake/stats
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const STOP = String(process.env.FAKE_STOP || '').split(',').filter(Boolean).map(Number);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// FAKE_SLOW=5: Handy 5 braucht 10 s je Eingabe und für den Bildschirmtext (ein hängendes WDA)
const SLOW = String(process.env.FAKE_SLOW || '').split(',').filter(Boolean).map(Number);

for (const dev of CFG.devices) {
  const s = { calls: 0, maxParallel: 0, active: 0, actions: [], app: 'com.apple.springboard' };
  const frames = fs.readdirSync(path.join(__dirname, 'frames')).filter(f => f.startsWith(`p${dev.id}_`)).map(f => fs.readFileSync(path.join(__dirname, 'frames', f)));
  http.createServer(async (req, res) => {
    const send = (v, extra = {}) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value: v, sessionId: 's1', ...extra })); };
    let body = ''; for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    const u = req.url;
    if (u === '/fake/stats') return send({ calls: s.calls, maxParallel: s.maxParallel, actions: s.actions.slice(-50), app: s.app, locked: !!s.locked, unlocks: s.unlocks || 0 });
    if (u === '/status') return send({ ready: true });
    if (u === '/session' && req.method === 'POST') return send({ sessionId: 's1' });
    if (u.endsWith('/window/size')) return send({ width: 375, height: 667 });
    if (u.endsWith('/appium/settings')) return send({});
    if (u.endsWith('/wda/batteryInfo')) return send({ level: 0.5 + dev.id / 20, state: 2 });
    if (u.endsWith('/wda/activeAppInfo')) return send({ bundleId: s.app });
    if (u === '/wda/locked') return send(s.locked = s.locked || false);
    if (u === '/fake/lock') { s.locked = true; return send(true); }        // Test: Auto-Sperre auslösen
    if (u === '/wda/unlock') { s.locked = false; s.unlocks = (s.unlocks || 0) + 1; return send(null); }
    if (u.includes('/source') && SLOW.includes(dev.id)) await sleep(10000);
    if (u.includes('/source')) return send(`<XCUIElementTypeApplication name="Instagram">${STOP.includes(dev.id) ? '<XCUIElementTypeStaticText label="We suspect automated behavior on your account"/>' : '<XCUIElementTypeStaticText label="Reels"/>'}</XCUIElementTypeApplication>`);
    if (u.endsWith('/element') && req.method === 'POST') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ value: { error: 'no such element' } })); }
    // Eingaben: dauern 150 ms, Parallelität wird gezählt
    s.calls++; s.active++; s.maxParallel = Math.max(s.maxParallel, s.active);
    await sleep(SLOW.includes(dev.id) ? 10000 : 150);
    s.active--;
    const kind = u.split('/').slice(-1)[0];
    if (kind === 'launch') s.app = b.bundleId;
    if (kind === 'homescreen') s.app = 'com.apple.springboard';
    s.actions.push({ t: Date.now(), kind, n: b.actions ? b.actions[0].actions.length : undefined });
    send(null);
  }).listen(dev.wda_port, '127.0.0.1');

  // MJPEG: 8 Bilder je Sekunde, wechselt alle 2 s das "Reel"
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
    let i = 0;
    const t = setInterval(() => {
      const f = frames[Math.floor(i++ / 16) % frames.length];
      res.write(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${f.length}\r\n\r\n`); res.write(f); res.write('\r\n\r\n');
    }, 125);
    req.on('close', () => clearInterval(t));
  }).listen(dev.mjpeg_port, '127.0.0.1');
}
console.log(`fake WDA für ${CFG.devices.length} Handys${STOP.length ? ', Sperrhinweis auf ' + STOP.join(',') : ''}`);
