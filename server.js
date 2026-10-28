#!/usr/bin/env node
// phone-lab Server: startet WDA je iPhone über go-ios (kein Xcode nötig), reicht den MJPEG-Stream durch,
// übersetzt Eingaben der Kachel-Seite in WDA-Aufrufe. Nur 127.0.0.1.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const usbmux = require('./usbmux');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const PORT = 3000;
const INSTAGRAM = 'com.burbn.instagram';
const IOS = fs.existsSync(path.join(ROOT, 'bin', 'ios')) ? path.join(ROOT, 'bin', 'ios') : 'ios';
const WDA_APP = path.join(ROOT, 'wda', 'WebDriverAgentRunner-Runner.app');
const BUNDLE = CFG.wda_bundle_id + '.xctrunner';
// waitForIdleTimeout 0 und animationCoolOffTimeout 0: WDA wartet nicht auf Ruhe der App, Eingaben kommen sofort an
const SETTINGS = { mjpegServerFramerate: 12, mjpegScalingFactor: 60, mjpegServerScreenshotQuality: 50, waitForIdleTimeout: 0, animationCoolOffTimeout: 0 };

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFile = name => fs.openSync(path.join(ROOT, 'logs', name), 'a');

// ---------- WDA-HTTP ----------
function wda(dev, method, p, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: dev.wda_port, method, path: p, timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(buf); } catch { return reject(new Error('WDA: keine JSON-Antwort')); }
        if (res.statusCode >= 400 || (j.value && j.value.error)) return reject(new Error('WDA: ' + (j.value && j.value.error || res.statusCode)));
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('WDA: Timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function session(dev) {
  if (dev.sid) return dev.sid;
  const r = await wda(dev, 'POST', '/session', { capabilities: { alwaysMatch: {} } });
  dev.sid = r.sessionId;
  const size = (await wda(dev, 'GET', `/session/${dev.sid}/window/size`)).value;
  dev.w = size.width; dev.h = size.height;
  await wda(dev, 'POST', `/session/${dev.sid}/appium/settings`, { settings: SETTINGS }).catch(() => {});
  return dev.sid;
}

// Führt einen Aufruf mit Session aus; bei Session-Fehler einmal neu anlegen.
async function withSession(dev, fn) {
  try { return await fn(await session(dev)); }
  catch (e) { dev.sid = null; return fn(await session(dev)); }
}

const touch = steps => ({ actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions: steps }] });
const px = (dev, nx, ny) => ({ x: Math.round(nx * dev.w), y: Math.round(ny * dev.h) });

const cmd = {
  // W3C-Actions sind hier ~0,55 s je Tipp, wda/tap ~0,85 s. Der Rest ist XCTest-Grundlatenz.
  tap: (dev, { x, y }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/actions`, touch([
    { type: 'pointerMove', duration: 0, ...px(dev, +x, +y) }, { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 40 }, { type: 'pointerUp', button: 0 }]))),
  doubletap: (dev, { x, y }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/actions`, touch([
    { type: 'pointerMove', duration: 0, ...px(dev, +x, +y) }, { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 40 }, { type: 'pointerUp', button: 0 }, { type: 'pause', duration: 80 },
    { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 40 }, { type: 'pointerUp', button: 0 }]))),
  // Wischt entlang der Mausspur: path = [{x,y,t}], t in ms ab Start, x/y als Anteil 0..1
  swipe: (dev, { path }) => {
    if (!Array.isArray(path) || path.length < 2) throw new Error('swipe braucht path');
    const pts = path.slice(-60).map(p => ({ ...px(dev, +p.x || 0, +p.y || 0), t: Math.max(0, +p.t || 0) }));
    const steps = [{ type: 'pointerMove', duration: 0, x: pts[0].x, y: pts[0].y }, { type: 'pointerDown', button: 0 }];
    for (let i = 1; i < pts.length; i++) steps.push({ type: 'pointerMove', duration: Math.min(1000, Math.max(10, pts[i].t - pts[i - 1].t)), x: pts[i].x, y: pts[i].y });
    steps.push({ type: 'pointerUp', button: 0 });
    return withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/actions`, touch(steps)));
  },
  text: (dev, { text }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/wda/keys`, { value: [String(text)] })),
  home: dev => wda(dev, 'POST', '/wda/homescreen'),
  instagram: dev => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/wda/apps/launch`, { bundleId: INSTAGRAM })),
};

// ---------- go-ios ----------
function ios(args, log) {
  return new Promise((resolve, reject) => {
    const p = spawn(IOS, args, { cwd: ROOT, stdio: ['ignore', log, log] });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ios ${args[0]} beendet mit ${code}`)));
    p.on('error', reject);
  });
}
function iosOut(args) {
  return new Promise(resolve => {
    let out = ''; const p = spawn(IOS, args, { cwd: ROOT });
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', () => resolve(out)); p.on('error', () => resolve(''));
  });
}

// Ein Tunnel-Dienst für alle Geräte (iOS 17+), ohne Admin-Rechte. Koppelt neue Geräte selbst (Dialog auf dem iPhone).
async function ensureTunnel() {
  if (!(await iosOut(['tunnel', 'ls'])).includes('agent is not running')) return;
  const child = spawn(IOS, ['tunnel', 'start', '--userspace'], { cwd: ROOT, stdio: ['ignore', logFile('tunnel.log'), logFile('tunnel.log')] });
  console.log(`Tunnel gestartet (pid ${child.pid})`);
  child.on('exit', code => { console.log(`Tunnel beendet (code ${code}), Neustart in 5 s`); setTimeout(ensureTunnel, 5000); });
}

// ---------- WDA-Prozess je Gerät mit Neustart ----------
async function startWda(dev) {
  if (dev.stopping) return;
  dev.sid = null; dev.fails = 0; dev.started = Date.now();
  const log = logFile(`handy-${dev.id}.log`);
  try {
    if (!(await usbmux.listDevices()).some(d => d.udid === dev.udid)) throw new Error('nicht per USB verbunden');
    await ios(['image', 'auto', '--udid=' + dev.udid], log);
    const marker = path.join(ROOT, 'logs', `installed-${dev.udid}`);
    if (!fs.existsSync(marker) || fs.statSync(marker).mtimeMs < fs.statSync(WDA_APP).mtimeMs) {
      await ios(['install', '--path=' + WDA_APP, '--udid=' + dev.udid], log);
      fs.writeFileSync(marker, new Date().toISOString());
      console.log(`[${dev.name}] WDA installiert. Auf dem iPhone jetzt die Entwickler-App vertrauen (Einstellungen > Allgemein > VPN und Geräteverwaltung).`);
    }
  } catch (e) {
    console.log(`[${dev.name}] Vorbereitung fehlgeschlagen: ${e.message}, neuer Versuch in 15 s`);
    return setTimeout(() => startWda(dev), 15000);
  }
  const child = spawn(IOS, ['runwda', '--bundleid=' + BUNDLE, '--testrunnerbundleid=' + BUNDLE, '--xctestconfig=WebDriverAgentRunner.xctest',
    '--env=USE_PORT=8100', '--env=MJPEG_SERVER_PORT=9100', '--udid=' + dev.udid], { cwd: ROOT, stdio: ['ignore', log, log] });
  dev.proc = child;
  console.log(`[${dev.name}] WDA gestartet (pid ${child.pid})`);
  child.on('exit', code => {
    console.log(`[${dev.name}] WDA beendet (code ${code}), Neustart in 5 s`);
    dev.proc = null; dev.sid = null;
    setTimeout(() => startWda(dev), 5000);
  });
}
function killWda(dev) {
  if (dev.proc) { try { dev.proc.kill('SIGTERM'); } catch {} }
}

async function health(dev) {
  try {
    const r = await wda(dev, 'GET', '/status', undefined, 3000);
    dev.ready = !!r.value.ready; dev.fails = 0;
    const b = await withSession(dev, sid => wda(dev, 'GET', `/session/${sid}/wda/batteryInfo`, undefined, 3000)).catch(() => null);
    dev.battery = b && b.value.level >= 0 ? Math.round(b.value.level * 100) : null;
  } catch {
    dev.ready = false; dev.sid = null;
    // erst nach 5 min Startzeit zählen: Entwicklerbild, Installation und erster Start dauern beim neuen Gerät einige Minuten
    if (dev.proc && Date.now() - dev.started > 300000 && ++dev.fails >= 3) { console.log(`[${dev.name}] WDA antwortet nicht, Neustart`); dev.fails = 0; killWda(dev); }
  }
}

// ---------- HTTP ----------
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const [, route, idStr, action] = req.url.split('?')[0].split('/');
  const dev = CFG.devices.find(d => String(d.id) === idStr);
  if (req.method === 'GET' && (route === '' || route === undefined)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && route === 'devices') {
    return json(res, 200, CFG.devices.map(d => ({ id: d.id, name: d.name, ready: !!d.ready, battery: d.battery ?? null, w: d.w, h: d.h, running: !!d.proc })));
  }
  if (!dev) return json(res, 404, { error: 'unbekanntes Gerät' });
  if (req.method === 'GET' && route === 'stream') {
    const up = http.request({ host: '127.0.0.1', port: dev.mjpeg_port, path: '/', method: 'GET' }, upRes => {
      res.writeHead(200, { 'Content-Type': upRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=--BoundaryString', 'Cache-Control': 'no-cache' });
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => up.destroy());
    return up.end();
  }
  if (req.method === 'POST' && route === 'cmd' && cmd[action]) {
    try { await cmd[action](dev, await body(req)); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  json(res, 404, { error: 'nicht gefunden' });
});

(async () => {
  if (!fs.existsSync(WDA_APP)) { console.error(`WDA-App fehlt: ${WDA_APP}. Auf einem Mac mit Xcode ./build-wda.sh ausführen.`); process.exit(1); }
  await ensureTunnel();
  for (const dev of CFG.devices) {
    usbmux.forward(dev.udid, 8100, dev.wda_port);
    usbmux.forward(dev.udid, 9100, dev.mjpeg_port);
    dev.started = Date.now(); startWda(dev);
  }
  setInterval(() => CFG.devices.forEach(health), 10000);
  server.listen(PORT, '127.0.0.1', () => console.log(`phone-lab läuft auf http://127.0.0.1:${PORT}`));
})();

function shutdown() { for (const d of CFG.devices) { d.stopping = true; killWda(d); } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
