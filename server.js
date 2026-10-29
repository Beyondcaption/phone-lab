#!/usr/bin/env node
// phone-lab Server: startet WDA je iPhone über go-ios (kein Xcode nötig), reicht den MJPEG-Stream durch,
// übersetzt Eingaben der Kachel-Seite in WDA-Aufrufe. Nur 127.0.0.1.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const usbmux = require('./usbmux');

const ROOT = __dirname;                                   // Programmdateien (in der App unveränderlich)
const DATA = process.env.PHONELAB_DATA || ROOT;           // Daten: Benutzer, Einstellungen, Logs, Entwicklerbilder, Pairings
// Test ohne iPhones: PHONELAB_FAKE=1 startet kein go-ios/usbmux, test/fake-wda.js spielt WDA auf den Ports aus devices.json
const FAKE = !!process.env.PHONELAB_FAKE;
for (const f of [path.join(DATA, '.env'), path.join(ROOT, '.env')]) { try { process.loadEnvFile(f); break; } catch {} }   // GITHUB_TOKEN für Desk-Updates
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const PORT = 3000;
const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();
const INSTAGRAM = 'com.burbn.instagram';
const IOS = fs.existsSync(path.join(ROOT, 'bin', 'ios')) ? path.join(ROOT, 'bin', 'ios') : 'ios';
const WDA_APP = path.join(ROOT, 'wda', 'WebDriverAgentRunner-Runner.app');
const BUNDLE = CFG.wda_bundle_id + '.xctrunner';
// waitForIdleTimeout 0 und animationCoolOffTimeout 0: WDA wartet nicht auf Ruhe der App, Eingaben kommen sofort an
// Stream-Stufen. Die JPEG-Qualität bringt wenig (Boden ~55 KB je Bild), wirksam sind Bildrate und Größe.
// light ~2 Mbit/s je Handy, normal ~4, smooth ~9, focus ~12 (nur das eine Handy, das groß offen ist).
const QUALITY = {
  light:  { mjpegServerFramerate: 6,  mjpegScalingFactor: 30, mjpegServerScreenshotQuality: 25 },
  normal: { mjpegServerFramerate: 8,  mjpegScalingFactor: 35, mjpegServerScreenshotQuality: 25 },
  smooth: { mjpegServerFramerate: 12, mjpegScalingFactor: 45, mjpegServerScreenshotQuality: 25 },
  focus:  { mjpegServerFramerate: 15, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 25 },
};
const SETTINGS = { ...QUALITY.normal, waitForIdleTimeout: 0, animationCoolOffTimeout: 0 };

fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
if (!fs.existsSync(path.join(DATA, 'devimages')) && fs.existsSync(path.join(ROOT, 'devimages'))) fs.cpSync(path.join(ROOT, 'devimages'), path.join(DATA, 'devimages'), { recursive: true });
const logFile = name => fs.openSync(path.join(DATA, 'logs', name), 'a');

// ---------- Einstellungen: Textbausteine, Notizen, Beschriftungen, Tagesziele (vom Admin gepflegt) ----------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const loadSettings = () => { try { return { snippets: { global: [], phone: {} }, notes: {}, labels: {}, targets: {}, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { snippets: { global: [], phone: {} }, notes: {}, labels: {}, targets: {} }; } };
const APPS = CFG.apps || { Instagram: INSTAGRAM };

// ---------- Benutzer, Login-Sitzungen, Protokoll ----------
const USERS_FILE = path.join(DATA, 'users.json');
const users = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users; } catch { return []; } };
const sessions = new Map();           // token -> { name, admin, devices, ip }
const loginFails = new Map();         // name|ip -> { n, until }
const LOCK_MS = 120000;               // Handy gilt als belegt, solange der letzte Befehl jünger als 2 min ist
// Dienstzugang für Hintergrund-Dienste auf diesem Mac (z. B. warmup.js): Token in DATA/service.token, kein Admin.
// Ein Dienst gibt jedem Menschen sofort ab und bekommt 409, solange ein Mensch das Handy hält.
const SERVICE_TOKEN_FILE = path.join(DATA, 'service.token');
if (!fs.existsSync(SERVICE_TOKEN_FILE)) fs.writeFileSync(SERVICE_TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
const SERVICE = { name: process.env.PHONELAB_SERVICE_NAME || 'claude', admin: false, devices: 'all', service: true, token: fs.readFileSync(SERVICE_TOKEN_FILE, 'utf8').trim() };
function serviceUser(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const a = Buffer.from(m[1]), b = Buffer.from(SERVICE.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? SERVICE : null;
}
function protokoll(user, ip, text) {
  fs.appendFileSync(path.join(DATA, 'logs', 'zugriff.log'), `${new Date().toISOString()} ${user || '-'} ${ip} ${text}\n`);
}
function checkPassword(u, pw) {
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(u.salt, 'hex'), 32), Buffer.from(u.hash, 'hex'));
}
function cookie(req) { const m = /(?:^|;\s*)pl=([a-f0-9]{48})/.exec(req.headers.cookie || ''); return m && sessions.get(m[1]); }
const allowed = (u, dev) => u.admin || u.devices === 'all' || (Array.isArray(u.devices) && u.devices.includes(dev.id));
const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>phone-lab sign in</title>
<style>body{margin:0;background:#0c0d0f;color:#fff;font:14px/20px Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:#15171a;padding:28px;border-radius:20px;width:340px;max-width:100%;display:flex;flex-direction:column;gap:16px}
h1{font-size:20px;line-height:28px;font-weight:600;margin:0;display:flex;align-items:center;gap:10px}p{margin:-8px 0 4px;color:#b4b4b4}
label{display:flex;flex-direction:column;gap:8px;color:#b4b4b4;font-weight:500;font-size:13px}
input{height:40px;padding:0 12px;border-radius:10px;border:1px solid #444;background:#0c0d0f;color:#fff;font:inherit}input:focus-visible,button:focus-visible{outline:2px solid #fff;outline-offset:2px}
button{height:40px;border-radius:999px;border:0;background:#fff;color:#000;font:500 14px Inter,system-ui,sans-serif;cursor:pointer;margin-top:4px}button:hover{background:#e6e6e6}
.m{color:#f07a8c;min-height:20px}</style>
<main><h1><svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect x="5.5" y="1.5" width="11" height="19" rx="3" fill="none" stroke="#fff" stroke-width="1.6"/><rect x="8" y="6" width="6" height="9" rx="1" fill="#c6f24e"/></svg>phone-lab</h1>
<p>Sign in to work on your phones.</p>
<form method="post" action="/login" style="display:flex;flex-direction:column;gap:16px"><label>Username<input name="name" autocomplete="username" required autofocus></label>
<label>Password<input name="pw" type="password" autocomplete="current-password" required></label><button>Sign in</button><div class="m" role="alert">${msg}</div></form></main>`;

// ---------- WDA-HTTP ----------
function wda(dev, method, p, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: dev.wda_port, method, path: p, timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(buf); } catch { return reject(new Error('WDA: no JSON reply')); }
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
  // Bestehende WDA-Sitzung übernehmen (z. B. von scroll.js), sonst anlegen. WDA hat immer nur eine.
  const st = await wda(dev, 'GET', '/status');
  dev.sid = st.sessionId || (await wda(dev, 'POST', '/session', { capabilities: { alwaysMatch: {} } })).sessionId;
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

// Warteschlange je Handy: XCTest verarbeitet ohnehin nur eine Eingabe nach der anderen. Parallele Aufrufe stauen sich
// sonst in WDA und kommen verspätet und in falscher Reihenfolge an. dev.pending zählt, was noch wartet.
// label sagt im Log, was gerade läuft. maxWait (ms): kommt der Aufruf so lange nicht dran, wird er verworfen statt später
// verspätet ausgeführt (ein Wisch von vor 8 s ist falsch), und der Mensch bekommt sofort eine Meldung.
function exec(dev, fn, label = 'call', maxWait = 0) {
  dev.pending = (dev.pending || 0) + 1;
  const queued = Date.now(); let started = false, cancelled = false;
  const run = (dev.q || Promise.resolve()).then(() => {
    if (cancelled) throw new Error('cancelled');
    started = true;
    const waited = Date.now() - queued;
    if (waited > 1500) console.log(`[${dev.name}] ${label} wartete ${waited} ms hinter ${dev.busyWith || '?'}`);
    dev.busyWith = label; dev.lastCmd = Date.now(); return fn();
  });
  dev.q = run.catch(() => {}).finally(() => { dev.pending--; dev.busyWith = null; dev.lastCmd = Date.now(); });
  if (!maxWait) return run;
  return Promise.race([run, new Promise((_, reject) => setTimeout(() => {
    if (!started) { cancelled = true; reject(new Error(`${dev.name} is busy (${dev.busyWith || 'previous command'}), try again`)); }
  }, maxWait))]);
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
    if (!Array.isArray(path) || path.length < 2) throw new Error('swipe needs a path');
    const cl = v => Math.min(1, Math.max(0, +v || 0));
    const pts = path.slice(-40).map(p => ({ ...px(dev, cl(p.x), cl(p.y)), t: Math.max(0, +p.t || 0) }));
    const steps = [{ type: 'pointerMove', duration: 0, x: pts[0].x, y: pts[0].y }, { type: 'pointerDown', button: 0 }];
    for (let i = 1; i < pts.length; i++) steps.push({ type: 'pointerMove', duration: Math.min(1000, Math.max(10, pts[i].t - pts[i - 1].t)), x: pts[i].x, y: pts[i].y });
    steps.push({ type: 'pointerUp', button: 0 });
    return withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/actions`, touch(steps)));
  },
  text: (dev, { text }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/wda/keys`, { value: [String(text)] })),
  // einzelne Tastendrücke (direktes Tippen im Focus): "\b" löscht, "\n" ist Enter
  keys: (dev, { text }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/wda/keys`, { value: [String(text).slice(0, 200)] })),
  // langer Druck, z. B. für Kontextmenüs
  press: (dev, { x, y, ms }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/actions`, touch([
    { type: 'pointerMove', duration: 0, ...px(dev, +x, +y) }, { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: Math.min(3000, Math.max(300, +ms || 800)) }, { type: 'pointerUp', button: 0 }]))),
  // App aus der Liste in devices.json öffnen
  launch: (dev, { app }) => { const id = APPS[app]; if (!id) throw new Error('unknown app'); return withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/wda/apps/launch`, { bundleId: id })); },
  home: dev => wda(dev, 'POST', '/wda/homescreen'),
  quality: (dev, { level }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/appium/settings`, { settings: QUALITY[level] || QUALITY.normal })),
  instagram: dev => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/wda/apps/launch`, { bundleId: INSTAGRAM })),
};
const HTTP_CMDS = new Set(['tap', 'doubletap', 'swipe', 'text', 'keys', 'press', 'launch', 'home', 'instagram']);

// ---------- go-ios ----------
function ios(args, log) {
  return new Promise((resolve, reject) => {
    const p = spawn(IOS, args, { cwd: DATA, stdio: ['ignore', log, log] });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ios ${args[0]} beendet mit ${code}`)));
    p.on('error', reject);
  });
}
function iosOut(args) {
  return new Promise(resolve => {
    let out = ''; const p = spawn(IOS, args, { cwd: DATA });
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', () => resolve(out)); p.on('error', () => resolve(''));
  });
}

// Ein Tunnel-Dienst für alle Geräte (iOS 17+), ohne Admin-Rechte. Koppelt neue Geräte selbst (Dialog auf dem iPhone).
async function ensureTunnel() {
  if (!(await iosOut(['tunnel', 'ls'])).includes('agent is not running')) return;
  const child = spawn(IOS, ['tunnel', 'start', '--userspace'], { cwd: DATA, stdio: ['ignore', logFile('tunnel.log'), logFile('tunnel.log')] });
  console.log(`Tunnel gestartet (pid ${child.pid})`);
  child.on('exit', code => { console.log(`Tunnel beendet (code ${code}), Neustart in 5 s`); setTimeout(ensureTunnel, 5000); });
}

// ---------- WDA-Prozess je Gerät mit Neustart ----------
async function startWda(dev) {
  if (dev.stopping) return;
  dev.sid = null; dev.fails = 0; dev.started = Date.now();
  if (!dev.ios) iosOut(['info', '--udid=' + dev.udid]).then(o => { try { const j = JSON.parse(o.trim().split('\n').filter(l => l.startsWith('{')).pop()); dev.ios = j.ProductVersion; dev.model = j.ProductType; } catch {} });
  const log = logFile(`handy-${dev.id}.log`);
  try {
    if (!(await usbmux.listDevices()).some(d => d.udid === dev.udid)) throw new Error('nicht per USB verbunden');
    await ios(['image', 'auto', '--udid=' + dev.udid], log);
    const marker = path.join(DATA, 'logs', `installed-${dev.udid}`);
    if (!fs.existsSync(marker) || fs.statSync(marker).mtimeMs < fs.statSync(WDA_APP).mtimeMs) {
      await ios(['install', '--path=' + WDA_APP, '--udid=' + dev.udid], log);
      fs.writeFileSync(marker, new Date().toISOString());
      console.log(`[${dev.name}] WDA installiert.`);
    }
  } catch (e) {
    console.log(`[${dev.name}] Vorbereitung fehlgeschlagen: ${e.message}, neuer Versuch in 15 s`);
    return setTimeout(() => startWda(dev), 15000);
  }
  const child = spawn(IOS, ['runwda', '--bundleid=' + BUNDLE, '--testrunnerbundleid=' + BUNDLE, '--xctestconfig=WebDriverAgentRunner.xctest',
    '--env=USE_PORT=8100', '--env=MJPEG_SERVER_PORT=9100', '--udid=' + dev.udid], { cwd: DATA, stdio: ['ignore', log, log] });
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
  // Während bedient wird, belegt jeder Zusatzaufruf den XCTest-Hauptthread und verzögert die Eingaben. Wer gerade
  // erfolgreich Befehle ausführt, ist ohnehin bereit: dann nichts abfragen.
  if (dev.ready && (dev.pending || Date.now() - (dev.lastCmd || 0) < 10000)) { dev.lastReady = Date.now(); return; }
  try {
    const r = await wda(dev, 'GET', '/status', undefined, 3000);
    dev.ready = !!r.value.ready; dev.fails = 0; if (dev.ready) { if (!dev.readySince) dev.readySince = Date.now(); dev.lastReady = Date.now(); }
    if (dev.ready && Date.now() - (dev.batteryAt || 0) > 60000) {   // Akku nur einmal je Minute, über die Warteschlange
      dev.batteryAt = Date.now();
      const b = await exec(dev, () => withSession(dev, sid => wda(dev, 'GET', `/session/${sid}/wda/batteryInfo`, undefined, 3000)), 'battery').catch(() => null);
      if (b) dev.battery = b.value.level >= 0 ? Math.round(b.value.level * 100) : null;
    }
  } catch {
    dev.ready = false; dev.sid = null; dev.readySince = null;
    // erst nach 5 min Startzeit zählen: Entwicklerbild, Installation und erster Start dauern beim neuen Gerät einige Minuten
    if (dev.proc && Date.now() - dev.started > 300000 && ++dev.fails >= 3) { console.log(`[${dev.name}] WDA antwortet nicht, Neustart`); dev.fails = 0; killWda(dev); }
  }
}

// Insights: aus logs/zugriff.log Sitzungen je Benutzer und Handy bilden. Befehle mit höchstens 2 min Abstand gehören zusammen.
// Das Log wächst unbegrenzt, darum nur neu rechnen, wenn es sich geändert hat (Größe + Zeit), höchstens alle 5 s.
let insCache = null, insKey = '', insAt = 0;
function insights() {
  let key = ''; try { const s = fs.statSync(path.join(DATA, 'logs', 'zugriff.log')); key = s.size + '|' + s.mtimeMs; } catch {}
  if (insCache && (key === insKey || Date.now() - insAt < 5000)) return { ...insCache, devices: deviceStates() };
  insCache = computeInsights(); insKey = key; insAt = Date.now();
  return { ...insCache, devices: deviceStates() };
}
const deviceStates = () => CFG.devices.map(d => ({ name: d.name, ready: !!d.ready, lockedBy: d.lockedBy && Date.now() - d.lockAt < LOCK_MS ? d.lockedBy : null }));
// Likes und Kommentare von Menschen je Handy heute: Doppeltipp = Like, gesendeter Text oder Enter = Kommentar
function todayCounts() {
  const { sessions } = insights(), today = new Date(); today.setHours(0, 0, 0, 0);
  const by = {};
  for (const s of sessions) {
    if (s.end < today.getTime() || s.user === SERVICE.name) continue;
    const b = by[s.phone] = by[s.phone] || { likes: 0, comments: 0 };
    b.likes += s.counts.doubletap || 0; b.comments += (s.counts.text || 0) + (s.counts.enter || 0);
  }
  return by;
}
function computeInsights() {
  let lines = []; try { lines = fs.readFileSync(path.join(DATA, 'logs', 'zugriff.log'), 'utf8').trim().split('\n'); } catch {}
  const sessions = [], open = new Map(), events = [];
  for (const line of lines) {
    const m = /^(\S+) (\S+) (\S+) (.*)$/.exec(line); if (!m) continue;
    const [, ts, name, ip, text] = m, t = Date.parse(ts);
    events.push({ time: ts, user: name, ip, text });
    const dm = /^((?:Handy|Phone) \d+) (\w+)/.exec(text); if (!dm) continue;
    const key = name + '|' + dm[1]; let cur = open.get(key);
    if (cur && t - cur.end <= LOCK_MS) { cur.end = t; cur.actions++; cur.counts[dm[2]] = (cur.counts[dm[2]] || 0) + 1; }
    else { cur = { user: name, phone: dm[1], start: t, end: t, actions: 1, counts: { [dm[2]]: 1 } }; sessions.push(cur); open.set(key, cur); }
    if (dm[2] === 'keys' && text.endsWith('(enter)')) cur.counts.enter = (cur.counts.enter || 0) + 1;
  }
  const now = Date.now(), day = 86400000;
  const dur = s => Math.max(30000, s.end - s.start);   // eine Sitzung zählt mindestens 30 s
  const sum = (filter) => { const by = {}; for (const s of sessions.filter(filter)) { const k = s.user + '|' + s.phone; by[k] = by[k] || { user: s.user, phone: s.phone, minutes: 0, sessions: 0, actions: 0, last: 0, likes: 0, texts: 0 }; const b = by[k]; b.minutes += dur(s) / 60000; b.sessions++; b.actions += s.actions; b.likes += s.counts.doubletap || 0; b.texts += (s.counts.text || 0) + (s.counts.keys ? 1 : 0); b.last = Math.max(b.last, s.end); } return Object.values(by).map(b => ({ ...b, minutes: Math.round(b.minutes) })).sort((a, b) => b.minutes - a.minutes); };
  // Verlauf: Minuten je Benutzer und Tag, letzte 30 Tage
  const days = {}; for (const s of sessions) { if (now - s.end > 30 * day) continue; const k = new Date(s.start).toISOString().slice(0, 10); days[k] = days[k] || {}; days[k][s.user] = (days[k][s.user] || 0) + dur(s) / 60000; }
  const history = Object.keys(days).sort().map(k => ({ day: k, users: Object.fromEntries(Object.entries(days[k]).map(([u, m]) => [u, Math.round(m)])) }));
  return { today: sum(s => now - s.end < day), week: sum(s => now - s.end < 7 * day), all: sum(() => true), recent: events.slice(-80).reverse(), history, sessions };
}

// ---------- MJPEG-Verteiler: eine Verbindung je Handy, alle Zuschauer bekommen die Bilder daraus.
// Ein Zuschauer, dessen Leitung nicht nachkommt, bekommt Bilder ausgelassen statt einen wachsenden Rückstand (sonst hinkt die Anzeige immer weiter nach).
const streams = new Map();
function streamClient(dev, res) {
  let st = streams.get(dev.id);
  if (!st) { st = { clients: new Set(), buf: Buffer.alloc(0), req: null, frames: 0 }; streams.set(dev.id, st); connectUpstream(dev, st); }
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache', Connection: 'close' });
  st.clients.add(res);
  res.on('close', () => { st.clients.delete(res); if (!st.clients.size) { if (st.req) st.req.destroy(); streams.delete(dev.id); } });
}
function connectUpstream(dev, st) {
  const retry = () => { st.req = null; if (streams.get(dev.id) === st && st.clients.size) setTimeout(() => connectUpstream(dev, st), 2000); };
  const req = http.request({ host: '127.0.0.1', port: dev.mjpeg_port, path: '/', method: 'GET' }, up => {
    // Stücke sammeln und erst zusammenfügen, wenn das Bild vollständig ist (statt bei jedem Stück neu zu kopieren)
    let parts = [], have = 0, need = 0;
    up.on('data', chunk => {
      parts.push(chunk); have += chunk.length;
      if (need && have < need) return;
      let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
      for (;;) {   // WDA schickt je Bild: Kopf mit Content-Length, Leerzeile, JPEG
        const m = /Content-Length:\s*(\d+)\r\n\r\n/i.exec(buf.subarray(0, 300).toString('latin1'));
        if (!m) { need = 0; if (buf.length > 4000000) buf = Buffer.alloc(0); break; }
        const start = m.index + m[0].length, len = +m[1];
        if (buf.length < start + len) { need = start + len; break; }
        broadcast(dev, st, buf.subarray(start, start + len)); buf = buf.subarray(start + len); need = 0;
      }
      parts = buf.length ? [buf] : []; have = buf.length;
    });
    up.on('end', retry); up.on('error', retry);
  });
  st.req = req; req.on('error', retry); req.end();
}
const CRLF = Buffer.from('\r\n');
function broadcast(dev, st, frame) {
  st.frames++; st.last = Buffer.from(frame); st.lastAt = Date.now();
  // einmal bauen, an alle schicken; wer nicht nachkommt, bekommt dieses Bild nicht
  const out = Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, CRLF]);
  for (const res of st.clients) { if (!res.writableNeedDrain) res.write(out); }
}
// Ein aktuelles JPEG für die Bewertung durch Claude: aus dem laufenden Stream, sonst eine kurze eigene Verbindung
function grabFrame(dev) {
  const st = streams.get(dev.id);
  if (st && st.last && Date.now() - st.lastAt < 1500) return Promise.resolve(st.last);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: dev.mjpeg_port, path: '/', timeout: 5000 }, res => {
      let buf = Buffer.alloc(0);
      res.on('data', c => {
        buf = Buffer.concat([buf, c]);
        const s = buf.indexOf(Buffer.from([0xff, 0xd8])), e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
        if (s >= 0 && e > s) { req.destroy(); resolve(buf.subarray(s, e + 2)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('no frame'))); req.on('error', reject);
  });
}

// ---------- Updates für phone-lab Desk: GitHub-Releases mit Tag desktop-v* durchreichen ----------
// Das Repo ist privat; der Token (nur Lesen, Contents) bleibt auf dem Mac. Beim Sprung von GitHub auf den Speicher-Host
// geht der Authorization-Kopf NICHT mit, sonst lehnt der Speicher ab. Fehlt etwas, antwortet der Server 404: die App bleibt
// dann einfach auf ihrer Version (fail-open).
const REPO = process.env.PHONELAB_REPO || 'Beyondcaption/phone-lab';
let relCache = null, relAt = 0;
function ghGet(url, accept, auth = true) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'phone-lab', Accept: accept };
    if (auth) headers.Authorization = 'Bearer ' + String(process.env.GITHUB_TOKEN || '').replace(/[^\x21-\x7E]/g, '');
    https.get(url, { headers, timeout: 15000 }, resolve).on('error', reject).on('timeout', function () { this.destroy(new Error('GitHub timeout')); });
  });
}
async function desktopRelease() {
  if (relCache && Date.now() - relAt < 600000) return relCache;
  const res = await ghGet(`https://api.github.com/repos/${REPO}/releases?per_page=30`, 'application/vnd.github+json');
  let b = ''; for await (const c of res) b += c;
  if (res.statusCode !== 200) throw new Error('GitHub ' + res.statusCode);
  const r = JSON.parse(b).find(x => !x.draft && /^desktop-v\d+\.\d+\.\d+$/.test(x.tag_name));
  relCache = r ? { version: r.tag_name.slice('desktop-v'.length), assets: r.assets.map(a => ({ name: a.name, id: a.id, size: a.size })) } : null; relAt = Date.now();
  return relCache;
}
async function desktopUpdate(res, name) {
  if (!process.env.GITHUB_TOKEN) return json(res, 404, { error: 'updates not configured (GITHUB_TOKEN)' });
  try {
    const rel = await desktopRelease();
    if (!rel) return json(res, 404, { error: 'no desktop release yet' });
    if (name === 'version') return json(res, 200, { version: rel.version, assets: rel.assets.map(a => a.name) });
    const asset = rel.assets.find(a => a.name === decodeURIComponent(name || ''));
    if (!asset) return json(res, 404, { error: 'unknown file' });
    const first = await ghGet(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, 'application/octet-stream');
    const up = first.statusCode === 302 || first.statusCode === 301 ? (first.resume(), await ghGet(first.headers.location, 'application/octet-stream', false)) : first;
    if (up.statusCode !== 200) { up.resume(); return json(res, 502, { error: 'GitHub ' + up.statusCode }); }
    res.writeHead(200, { 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'Content-Length': up.headers['content-length'] || asset.size, 'Cache-Control': 'no-cache' });
    up.pipe(res);
  } catch (e) { json(res, 502, { error: e.message }); }
}

// ---------- HTTP ----------
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function rawBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const [, route, idStr, action] = req.url.split('?')[0].split('/');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const html = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };

  if (route === 'login' && req.method === 'POST') {
    const b = new URLSearchParams(await rawBody(req));
    const name = (b.get('name') || '').trim().toLowerCase(), pw = b.get('pw') || '';
    const key = name + '|' + ip, f = loginFails.get(key);
    if (f && f.until > Date.now()) return html(429, LOGIN_HTML('Too many attempts, please wait 1 minute'));
    const u = users().find(x => x.name === name);
    if (!u || !checkPassword(u, pw)) {
      const n = (f ? f.n : 0) + 1; loginFails.set(key, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      protokoll(name, ip, 'login failed'); return html(401, LOGIN_HTML('Wrong username or password'));
    }
    loginFails.delete(key);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { name: u.name, admin: !!u.admin, devices: u.devices || [], ip });
    protokoll(u.name, ip, 'login');
    res.writeHead(303, { 'Set-Cookie': `pl=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`, Location: '/' }); return res.end();
  }
  // Updates für phone-lab Desk, ohne Anmeldung (die App enthält keine Schlüssel). Nur mit GITHUB_TOKEN in .env, sonst 404.
  if (req.method === 'GET' && route === 'desktop') return desktopUpdate(res, idStr);
  // Nur im Testbetrieb ohne iPhones: PHONELAB_AUTOLOGIN=name meldet jede Anfrage ohne Cookie als diesen Admin an (für Screenshots)
  const user = cookie(req) || serviceUser(req) || (FAKE && process.env.PHONELAB_AUTOLOGIN ? { name: process.env.PHONELAB_AUTOLOGIN, admin: true, devices: 'all', ip } : null);
  if (route === 'logout') {
    if (user) { protokoll(user.name, ip, 'logout'); for (const [t, u] of sessions) if (u === user) sessions.delete(t); }
    res.writeHead(303, { 'Set-Cookie': 'pl=; Max-Age=0; Path=/', Location: '/' }); return res.end();
  }
  if (!user) {
    if (req.method === 'GET' && (route === '' || route === undefined || route === 'login')) return html(200, LOGIN_HTML());
    return json(res, 401, { error: 'not signed in' });
  }
  if (req.method === 'GET' && (route === '' || route === undefined || route === 'login')) {
    // no-cache: nach einem Update nie das alte Dashboard aus dem Browser-Speicher zeigen
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && route === 'charts.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=3600' });
    return fs.createReadStream(path.join(ROOT, 'charts.js')).pipe(res);
  }
  if (route === 'users') {
    if (!user.admin) return json(res, 403, { error: 'admins only' });
    const db = (() => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return { users: [] }; } })();
    const save = () => fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
    const pub = u => ({ name: u.name, admin: !!u.admin, devices: u.devices === 'all' ? 'all' : (u.devices || []) });
    if (req.method === 'GET') return json(res, 200, db.users.map(pub));
    const b = await body(req);
    const name = String(b.name || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,20}$/.test(name)) return json(res, 400, { error: 'name: 2-20 letters, digits, - or _' });
    const u = db.users.find(x => x.name === name);
    if (req.method === 'DELETE') {
      if (!u) return json(res, 404, { error: 'unknown user' });
      if (u.admin && db.users.filter(x => x.admin).length === 1) return json(res, 400, { error: 'cannot remove the last admin' });
      db.users = db.users.filter(x => x !== u); save(); for (const [t, s] of sessions) if (s.name === name) sessions.delete(t);
      protokoll(user.name, ip, `removes user ${name}`); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const devices = b.devices === 'all' ? 'all' : (Array.isArray(b.devices) ? b.devices.map(Number).filter(Boolean) : undefined);
      if (b.pw !== undefined && String(b.pw).length < 10) return json(res, 400, { error: 'password: at least 10 characters' });
      let target = u;
      if (!target) {
        if (b.pw === undefined) return json(res, 400, { error: 'password required for a new user' });
        target = { name, salt: '', hash: '', admin: false, devices: 'all' }; db.users.push(target);
      }
      if (b.pw !== undefined) { const salt = crypto.randomBytes(16); target.salt = salt.toString('hex'); target.hash = crypto.scryptSync(String(b.pw), salt, 32).toString('hex'); }
      if (b.admin !== undefined) target.admin = !!b.admin;
      if (devices !== undefined) target.devices = devices;
      if (!db.users.some(x => x.admin)) return json(res, 400, { error: 'at least one admin is required' });
      save(); for (const [t, s] of sessions) if (s.name === name) { s.admin = !!target.admin; s.devices = target.devices; }
      protokoll(user.name, ip, `${u ? 'updates' : 'adds'} user ${name}${b.pw !== undefined ? ' (password)' : ''}`);
      return json(res, 200, { ok: true, user: pub(target) });
    }
  }
  if (req.method === 'GET' && route === 'insights') {
    if (!user.admin) return json(res, 403, { error: 'admins only' });
    return json(res, 200, insights());
  }
  if (route === 'settings') {
    if (req.method === 'GET') { const st = loadSettings(); return json(res, 200, { ...st, apps: Object.keys(APPS), targets: user.admin ? st.targets : { [user.name]: st.targets[user.name] || null } }); }
    if (req.method === 'POST') {
      if (!user.admin) return json(res, 403, { error: 'admins only' });
      const b = await body(req), st = loadSettings();
      for (const k of ['snippets', 'notes', 'labels', 'targets']) if (b[k] !== undefined) st[k] = b[k];
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 2) + '\n'); protokoll(user.name, ip, 'updates settings'); return json(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET' && route === 'me') {
    const t = insights().today.filter(r => r.user === user.name);
    const sum = k => t.reduce((a, r) => a + (r[k] || 0), 0);
    return json(res, 200, { user: user.name, minutes: sum('minutes'), actions: sum('actions'), texts: sum('texts'), likes: sum('likes'), target: loadSettings().targets[user.name] || null });
  }
  if (req.method === 'GET' && route === 'insights.csv') {
    if (!user.admin) return json(res, 403, { error: 'admins only' });
    const rows = insights().sessions.map(s => [new Date(s.start).toISOString(), new Date(s.end).toISOString(), s.user, s.phone, Math.round(Math.max(30000, s.end - s.start) / 60000 * 10) / 10, s.actions, s.counts.text || 0, s.counts.doubletap || 0].join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="phone-lab-sessions.csv"' });
    return res.end(['start,end,user,phone,minutes,actions,texts,likes', ...rows].join('\n') + '\n');
  }
  if (req.method === 'GET' && route === 'devices') {
    const counts = todayCounts();
    return json(res, 200, { user: user.name, admin: user.admin, version: VERSION, devices: CFG.devices.filter(d => allowed(user, d)).map(d => ({
      id: d.id, name: d.name, ready: !!d.ready, battery: d.battery ?? null, w: d.w, h: d.h, running: !!(d.proc || FAKE),
      ios: d.ios || null, uptimeMin: d.readySince ? Math.round((Date.now() - d.readySince) / 60000) : null, offlineMin: !d.ready && d.lastReady ? Math.round((Date.now() - d.lastReady) / 60000) : null,
      lockedBy: d.lockedBy && Date.now() - d.lockAt < LOCK_MS && d.lockedBy !== user.name ? d.lockedBy : null,
      today: counts[d.name] || { likes: 0, comments: 0 } })) });
  }
  // Durchreichung zu einem Zusatzdienst auf diesem Mac (warmup.js auf PHONELAB_AGENT_PORT). Der Server kennt dessen Inhalt
  // nicht; er hängt nur an, wer angemeldet ist, und das Dienst-Token, damit der Dienst nur Anfragen über den Server annimmt.
  if (route === 'agent' && !user.service) return agentProxy(req, res, user);
  const dev = CFG.devices.find(d => String(d.id) === idStr);
  if (!dev || !allowed(user, dev)) return json(res, 404, { error: 'unknown phone' });
  if (req.method === 'GET' && route === 'stream') return streamClient(dev, res);
  // ein einzelnes aktuelles Bild des Bildschirms (JPEG)
  if (req.method === 'GET' && route === 'frame') {
    try { const f = await grabFrame(dev); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': f.length, 'Cache-Control': 'no-store' }); return res.end(f); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (req.method === 'POST' && route === 'cmd' && action === 'reboot') {
    if (!user.admin) return json(res, 403, { error: 'admins only' });
    protokoll(user.name, ip, `${dev.name} reboot`); dev.sid = null;
    try { await ios(['reboot', '--udid=' + dev.udid], logFile(`handy-${dev.id}.log`)); return json(res, 200, { ok: true }); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && route === 'cmd' && action === 'quality') {
    const b = await body(req);
    // auch über die Warteschlange, damit der Einstellungs-Aufruf nicht parallel zu einer Eingabe an WDA geht
    try { await exec(dev, () => cmd.quality(dev, b), 'quality ' + b.level, 8000); return json(res, 200, { ok: true }); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && route === 'cmd' && HTTP_CMDS.has(action)) {
    const b = await body(req);
    // Auto-Scroll aus dem Browser: wartet noch ein Befehl, diesen Wisch verwerfen statt ihn hinten anzustellen
    if (b.auto && dev.pending) return json(res, 200, { ok: true, skipped: true });
    // Sperre: belegt, solange ein anderer in den letzten 2 min einen Befehl geschickt hat. Hält ein Dienst das Handy,
    // übernimmt jeder Mensch sofort; ein Dienst bekommt 409, solange ein Mensch es hält.
    const held = dev.lockedBy && dev.lockedBy !== user.name && Date.now() - dev.lockAt < LOCK_MS;
    if (held && (user.service || !dev.lockService)) return json(res, 409, { ok: false, error: `${dev.name} is in use by ${dev.lockedBy}` });
    if (dev.lockedBy !== user.name) protokoll(user.name, ip, `takes over ${dev.name}`);
    dev.lockedBy = user.name; dev.lockService = !!user.service; dev.lockAt = Date.now();
    protokoll(user.name, ip, `${dev.name} ${action}${action === 'text' ? ' (' + String(b.text || '').length + ' chars)' : ''}${action === 'keys' && String(b.text || '').includes('\n') ? ' (enter)' : ''}`);
    try { await exec(dev, () => cmd[action](dev, b), `${action} by ${user.name}`, 8000); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  json(res, 404, { error: 'not found' });
});

const AGENT_PORT = +(process.env.PHONELAB_AGENT_PORT || 3001);
function agentProxy(req, res, user) {
  const p = http.request({ host: '127.0.0.1', port: AGENT_PORT, method: req.method, path: req.url.replace(/^\/agent/, '') || '/', timeout: 15000,
    headers: { 'Content-Type': req.headers['content-type'] || 'application/json', 'X-Phonelab-Token': SERVICE.token,
      'X-Phonelab-User': user.name, 'X-Phonelab-Admin': user.admin ? '1' : '0', 'X-Phonelab-Devices': JSON.stringify(user.devices) } }, up => {
    res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json' }); up.pipe(res);
  });
  p.on('timeout', () => p.destroy(new Error('timeout')));
  p.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'service not running' }); });
  req.pipe(p);
}

(async () => {
  if (!FAKE && !fs.existsSync(WDA_APP)) { console.error(`WDA-App fehlt: ${WDA_APP}. Auf einem Mac mit Xcode ./build-wda.sh ausführen.`); process.exit(1); }
  if (!users().length) { console.error('Keine Benutzer. Erst anlegen: node user.js add <name> --admin'); process.exit(1); }
  console.log(`Daten in ${DATA}${FAKE ? ' (Testbetrieb ohne iPhones)' : ''}`);
  if (!FAKE) {
    await ensureTunnel();
    for (const dev of CFG.devices) {
      usbmux.forward(dev.udid, 8100, dev.wda_port);
      usbmux.forward(dev.udid, 9100, dev.mjpeg_port);
      dev.started = Date.now(); startWda(dev);
    }
  }
  setInterval(() => CFG.devices.forEach(health), 10000);
  setTimeout(() => CFG.devices.forEach(health), 1500);
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} ist belegt, vermutlich von einer alten phone-lab-Installation (lsof -nP -iTCP:${PORT} -sTCP:LISTEN). phone-lab.app einmal öffnen beendet sie.`);
    else console.error(e); process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`phone-lab ${VERSION} läuft auf http://127.0.0.1:${PORT}`));
})();

function shutdown() { for (const d of CFG.devices) { d.stopping = true; killWda(d); } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
