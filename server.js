#!/usr/bin/env node
// phone-lab Server: startet WDA je iPhone über go-ios (kein Xcode nötig), reicht den MJPEG-Stream durch,
// übersetzt Eingaben der Kachel-Seite in WDA-Aufrufe. Nur 127.0.0.1.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const usbmux = require('./usbmux');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const PORT = 3000;
const INSTAGRAM = 'com.burbn.instagram';
const IOS = fs.existsSync(path.join(ROOT, 'bin', 'ios')) ? path.join(ROOT, 'bin', 'ios') : 'ios';
const WDA_APP = path.join(ROOT, 'wda', 'WebDriverAgentRunner-Runner.app');
const BUNDLE = CFG.wda_bundle_id + '.xctrunner';
// waitForIdleTimeout 0 und animationCoolOffTimeout 0: WDA wartet nicht auf Ruhe der App, Eingaben kommen sofort an
// Stream klein halten, damit er auch über das Internet flüssig bleibt. Die JPEG-Qualität ignoriert WDA, wirksam sind Bildrate und Größe.
// Raster: 6 Bilder/s bei 30 % (etwa 2 Mbit/s je Handy). Focus: 10 Bilder/s bei 45 % (etwa 7 Mbit/s), nur für das eine Handy, das groß offen ist.
const QUALITY = { low: { mjpegServerFramerate: 6, mjpegScalingFactor: 30 }, high: { mjpegServerFramerate: 10, mjpegScalingFactor: 45 } };
const SETTINGS = { ...QUALITY.low, waitForIdleTimeout: 0, animationCoolOffTimeout: 0 };

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFile = name => fs.openSync(path.join(ROOT, 'logs', name), 'a');

// ---------- Benutzer, Login-Sitzungen, Protokoll ----------
const USERS_FILE = path.join(ROOT, 'users.json');
const users = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users; } catch { return []; } };
const sessions = new Map();           // token -> { name, admin, devices, ip }
const loginFails = new Map();         // name|ip -> { n, until }
const LOCK_MS = 120000;               // Handy gilt als belegt, solange der letzte Befehl jünger als 2 min ist
function protokoll(user, ip, text) {
  fs.appendFileSync(path.join(ROOT, 'logs', 'zugriff.log'), `${new Date().toISOString()} ${user || '-'} ${ip} ${text}\n`);
}
function checkPassword(u, pw) {
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(u.salt, 'hex'), 32), Buffer.from(u.hash, 'hex'));
}
function cookie(req) { const m = /(?:^|;\s*)pl=([a-f0-9]{48})/.exec(req.headers.cookie || ''); return m && sessions.get(m[1]); }
const allowed = (u, dev) => u.admin || u.devices === 'all' || (Array.isArray(u.devices) && u.devices.includes(dev.id));
const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="de"><meta charset="utf-8"><title>phone-lab sign in</title>
<style>body{margin:0;background:#111;color:#ddd;font:15px system-ui;display:flex;align-items:center;justify-content:center;height:100vh}
form{background:#1c1c1c;padding:24px;border-radius:8px;display:flex;flex-direction:column;gap:10px;width:260px}input,button{padding:8px;background:#222;color:#ddd;border:1px solid #444}button{cursor:pointer}.m{color:#e66;min-height:18px}</style>
<form method="post" action="/login"><b>phone-lab</b><input name="name" placeholder="Username" autocomplete="username" required autofocus>
<input name="pw" type="password" placeholder="Password" autocomplete="current-password" required><button>Sign in</button><div class="m">${msg}</div></form>`;

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
  home: dev => wda(dev, 'POST', '/wda/homescreen'),
  quality: (dev, { level }) => withSession(dev, sid => wda(dev, 'POST', `/session/${sid}/appium/settings`, { settings: QUALITY[level] || QUALITY.low })),
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
      console.log(`[${dev.name}] WDA installiert.`);
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

// Insights: aus logs/zugriff.log Sitzungen je Benutzer und Handy bilden. Befehle mit höchstens 2 min Abstand gehören zusammen.
function insights() {
  let lines = []; try { lines = fs.readFileSync(path.join(ROOT, 'logs', 'zugriff.log'), 'utf8').trim().split('\n'); } catch {}
  const sessions = [], open = new Map(), events = [];
  for (const line of lines) {
    const m = /^(\S+) (\S+) (\S+) (.*)$/.exec(line); if (!m) continue;
    const [, ts, name, ip, text] = m, t = Date.parse(ts);
    events.push({ time: ts, user: name, ip, text });
    const dm = /^((?:Handy|Phone) \d+) (\w+)/.exec(text); if (!dm) continue;
    const key = name + '|' + dm[1], cur = open.get(key);
    if (cur && t - cur.end <= LOCK_MS) { cur.end = t; cur.actions++; cur.counts[dm[2]] = (cur.counts[dm[2]] || 0) + 1; }
    else { const sess = { user: name, phone: dm[1], start: t, end: t, actions: 1, counts: { [dm[2]]: 1 } }; sessions.push(sess); open.set(key, sess); }
  }
  const now = Date.now(), day = 86400000;
  const dur = s => Math.max(30000, s.end - s.start);   // eine Sitzung zählt mindestens 30 s
  const sum = (filter) => { const by = {}; for (const s of sessions.filter(filter)) { const k = s.user + '|' + s.phone; by[k] = by[k] || { user: s.user, phone: s.phone, minutes: 0, sessions: 0, actions: 0, last: 0, likes: 0 }; const b = by[k]; b.minutes += dur(s) / 60000; b.sessions++; b.actions += s.actions; b.likes += s.counts.doubletap || 0; b.last = Math.max(b.last, s.end); } return Object.values(by).map(b => ({ ...b, minutes: Math.round(b.minutes) })).sort((a, b) => b.minutes - a.minutes); };
  return { today: sum(s => now - s.end < day), week: sum(s => now - s.end < 7 * day), all: sum(() => true), recent: events.slice(-80).reverse(),
    devices: CFG.devices.map(d => ({ name: d.name, ready: !!d.ready, lockedBy: d.lockedBy && now - d.lockAt < LOCK_MS ? d.lockedBy : null })) };
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
    up.on('data', chunk => {
      st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
      for (;;) {   // WDA schickt je Bild: Kopf mit Content-Length, Leerzeile, JPEG
        const m = /Content-Length:\s*(\d+)\r\n\r\n/i.exec(st.buf.subarray(0, 300).toString('latin1'));
        if (!m) { if (st.buf.length > 4000000) st.buf = Buffer.alloc(0); break; }
        const start = m.index + m[0].length, len = +m[1];
        if (st.buf.length < start + len) break;
        broadcast(st, st.buf.subarray(start, start + len)); st.buf = st.buf.subarray(start + len);
      }
    });
    up.on('end', retry); up.on('error', retry);
  });
  st.req = req; req.on('error', retry); req.end();
}
function broadcast(st, frame) {
  st.frames++;
  const head = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  for (const res of st.clients) { if (res.writableNeedDrain) continue; res.write(Buffer.concat([head, frame, Buffer.from('\r\n')])); }
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
  const user = cookie(req);
  if (route === 'logout') {
    if (user) { protokoll(user.name, ip, 'logout'); for (const [t, u] of sessions) if (u === user) sessions.delete(t); }
    res.writeHead(303, { 'Set-Cookie': 'pl=; Max-Age=0; Path=/', Location: '/' }); return res.end();
  }
  if (!user) {
    if (req.method === 'GET' && (route === '' || route === undefined || route === 'login')) return html(200, LOGIN_HTML());
    return json(res, 401, { error: 'not signed in' });
  }
  if (req.method === 'GET' && (route === '' || route === undefined || route === 'login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
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
  if (req.method === 'GET' && route === 'devices') {
    return json(res, 200, { user: user.name, admin: user.admin, devices: CFG.devices.filter(d => allowed(user, d)).map(d => ({
      id: d.id, name: d.name, ready: !!d.ready, battery: d.battery ?? null, w: d.w, h: d.h, running: !!d.proc,
      lockedBy: d.lockedBy && Date.now() - d.lockAt < LOCK_MS && d.lockedBy !== user.name ? d.lockedBy : null })) });
  }
  const dev = CFG.devices.find(d => String(d.id) === idStr);
  if (!dev || !allowed(user, dev)) return json(res, 404, { error: 'unknown phone' });
  if (req.method === 'GET' && route === 'stream') return streamClient(dev, res);
  if (req.method === 'POST' && route === 'cmd' && action === 'quality') {
    try { await cmd.quality(dev, await body(req)); return json(res, 200, { ok: true }); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && route === 'cmd' && cmd[action]) {
    // Sperre: belegt, solange ein anderer in den letzten 2 min einen Befehl geschickt hat
    if (dev.lockedBy && dev.lockedBy !== user.name && Date.now() - dev.lockAt < LOCK_MS) return json(res, 409, { ok: false, error: `${dev.name} is in use by ${dev.lockedBy}` });
    if (dev.lockedBy !== user.name) protokoll(user.name, ip, `takes over ${dev.name}`);
    dev.lockedBy = user.name; dev.lockAt = Date.now();
    const b = await body(req);
    protokoll(user.name, ip, `${dev.name} ${action}${action === 'text' ? ' (' + String(b.text || '').length + ' chars)' : ''}`);
    try { await cmd[action](dev, b); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  json(res, 404, { error: 'not found' });
});

(async () => {
  if (!fs.existsSync(WDA_APP)) { console.error(`WDA-App fehlt: ${WDA_APP}. Auf einem Mac mit Xcode ./build-wda.sh ausführen.`); process.exit(1); }
  if (!users().length) { console.error('Keine Benutzer. Erst anlegen: node user.js add <name> --admin'); process.exit(1); }
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
