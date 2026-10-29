#!/usr/bin/env node
// Warmup-Dienst, ein eigener Prozess neben dem Server. Er spricht den Server nur über dessen normale Befehle an
// (/devices, /frame, /cmd mit dem Dienst-Token aus DATA/service.token), wie eine VA. Der Server bleibt reine Fernsteuerung:
// hält ein Mensch ein Handy, bekommt dieser Dienst 409 und hört auf.
// Inhalt: 14-Tage-Plan je Handy, Scroll-Sitzungen (Claude wischt nur: keine Likes, Kommentare, Follows, DMs, Profilbesuche,
// siehe BRIEF.md), Tagesziele für die VA, Alarm bei Warnhinweisen. Ohne ANTHROPIC_API_KEY keine Sitzungen: ohne den Blick
// von Claude auf den Bildschirm gäbe es keine Erkennung von Captcha oder Sperrhinweisen.
// Das Dashboard erreicht diesen Dienst über die Durchreichung /agent/* des Servers.
// Aufruf: PHONELAB_DATA=<Datenordner> node warmup.js     Selbsttest ohne Gerät: node warmup.js --dry
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DATA = process.env.PHONELAB_DATA || __dirname;
const SERVER = (process.env.PHONELAB_SERVER || 'http://127.0.0.1:3000').replace(/\/$/, '');
const PORT = +(process.env.PHONELAB_AGENT_PORT || 3001);
for (const f of [path.join(DATA, '.env'), path.join(__dirname, '.env')]) { try { process.loadEnvFile(f); break; } catch {} }
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const PRICE = { in: 0.10 / 1e6, out: 0.50 / 1e6 };          // Haiku 5.5, $ je Token
const FAKE_JUDGE = process.env.WARMUP_FAKE_JUDGE;            // nur Tests: "3" = Handy 3 zeigt eine Warnung, sonst normale Reels

// Vorlage: scroll = Minuten Claude je Tag, sessions = Anzahl Sitzungen, likes/comments = Ziel für die VA, post = Post über Metricool fällig
const TEMPLATE = [
  { scroll: 40, sessions: 3, likes: 0,  comments: 0, post: false },
  { scroll: 40, sessions: 3, likes: 0,  comments: 0, post: false },
  { scroll: 40, sessions: 3, likes: 0,  comments: 0, post: false },
  { scroll: 35, sessions: 3, likes: 3,  comments: 0, post: false },
  { scroll: 35, sessions: 3, likes: 5,  comments: 1, post: false },
  { scroll: 30, sessions: 3, likes: 6,  comments: 1, post: false },
  { scroll: 30, sessions: 3, likes: 8,  comments: 2, post: false },
  { scroll: 30, sessions: 3, likes: 8,  comments: 2, post: true  },
  { scroll: 25, sessions: 2, likes: 10, comments: 2, post: false },
  { scroll: 25, sessions: 2, likes: 10, comments: 3, post: true  },
  { scroll: 25, sessions: 2, likes: 12, comments: 3, post: false },
  { scroll: 25, sessions: 2, likes: 12, comments: 3, post: true  },
  { scroll: 20, sessions: 2, likes: 15, comments: 4, post: false },
  { scroll: 20, sessions: 2, likes: 15, comments: 4, post: true  },
];

// ---------- Zufall und Zeit ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const lognormal = (median, sigma) => median * Math.exp(sigma * (Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random())));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const fmtHm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
function dayIndex(start, today = localDay()) {          // 1 am Startdatum, null vor dem Start
  if (!start) return null;
  const a = Date.parse(start + 'T00:00:00'), b = Date.parse(today + 'T00:00:00');
  if (isNaN(a)) return null;
  const n = Math.round((b - a) / 86400000) + 1;
  return n >= 1 ? n : null;
}
// Wischweg wie mit dem Daumen: entschieden, mindestens halber Bildschirm, damit Reels sicher zum nächsten Video springt
function swipePath(dir = -1) {
  const x0 = rnd(0.35, 0.65), y0 = dir < 0 ? rnd(0.7, 0.85) : rnd(0.15, 0.3);
  const len = rnd(0.55, 0.7), drift = rnd(-0.05, 0.05), bend = rnd(-0.03, 0.03);
  const total = rnd(160, 300), n = 5 + Math.floor(rnd(0, 4)), pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, e = 1 - Math.pow(1 - u, 1.5);
    pts.push({ x: clamp(x0 + drift * e + bend * Math.sin(Math.PI * e), 0.05, 0.95), y: clamp(y0 + dir * len * e, 0.05, 0.95), t: Math.round(total * u + rnd(-6, 6)) });
  }
  pts[0].t = 0;
  for (let i = 1; i < pts.length; i++) pts[i].t = Math.max(pts[i].t, pts[i - 1].t + 10);
  return pts;
}
const dwell = fits => clamp(lognormal(fits ? 16 : 6, 0.7), 1.5, fits ? 70 : 40) * 1000;   // Median 6 s, passend 16 s

if (process.argv.includes('--dry')) {      // Selbsttest der Verteilungen ohne Gerät und ohne Server
  const assert = (ok, msg) => { if (!ok) { console.error('FEHLER:', msg); process.exit(1); } };
  const d = Array.from({ length: 2000 }, () => dwell(false) / 1000).sort((a, b) => a - b), p = swipePath(-1), back = swipePath(+1);
  assert(p.every(q => q.x >= 0.05 && q.x <= 0.95 && q.y >= 0.05 && q.y <= 0.95), 'Wischweg außerhalb');
  assert(p[0].y - p[p.length - 1].y > 0.5 && back[back.length - 1].y - back[0].y > 0.5, 'Wisch zu kurz');
  assert(p.every((q, i) => i === 0 || q.t >= p[i - 1].t), 'Zeiten nicht aufsteigend');
  assert(d[1000] > 4 && d[1000] < 9, 'Median Verweildauer unplausibel: ' + d[1000]);
  assert(dayIndex('2026-10-29', '2026-10-29') === 1 && dayIndex('2026-10-29', '2026-11-11') === 14 && dayIndex('2026-10-30', '2026-10-29') === null, 'Warmup-Tag falsch');
  console.log('Verweildauer s: median', d[1000].toFixed(1), 'p90', d[1800].toFixed(1)); console.log('dry ok'); process.exit(0);
}

// ---------- Server über HTTP, mit Dienst-Token ----------
const TOKEN_FILE = path.join(DATA, 'service.token');
const token = () => fs.readFileSync(TOKEN_FILE, 'utf8').trim();
function server(method, p, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(SERVER + p);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, timeout,
      headers: { Authorization: 'Bearer ' + token(), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const parts = []; res.on('data', c => parts.push(c));
      res.on('end', () => { const buf = Buffer.concat(parts); resolve({ status: res.statusCode, buf, json: () => { try { return JSON.parse(buf.toString()); } catch { return {}; } } }); });
    });
    req.on('timeout', () => req.destroy(new Error('server timeout'))); req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}
let devices = [];                                     // letzter Stand von /devices (aus Sicht des Dienstes)
async function loadDevices() { try { const r = await server('GET', '/devices', undefined, 8000); if (r.status === 200) devices = r.json().devices || devices; } catch {} return devices; }
const devById = id => devices.find(d => String(d.id) === String(id));

// ---------- Claude: passt das Reel zur Nische, zeigt der Bildschirm eine Warnung? ----------
async function judge(jpeg, niche, id) {
  if (FAKE_JUDGE !== undefined) return { fits: Math.random() < 0.3, warning: FAKE_JUDGE.split(',').includes(String(id)), reason: 'fake judge', cost: 0 };
  const key = process.env.ANTHROPIC_API_KEY;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': key.replace(/[^\x21-\x7E]/g, ''), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 200, thinking: { type: 'disabled' }, output_config: { effort: 'low' },
        system: 'You rate screenshots of the Instagram Reels view. Reply with JSON only: {"fits": true|false, "warning": true|false, "reason": "short"}. fits = the content matches the given niche. warning = the screen shows a captcha, a block or restriction notice, an unusual-activity notice, a login prompt, any dialog, or anything that is not a normal reel in the Instagram app.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: `Niche: ${niche || 'any'}` }] }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`API ${r.status}: ${(j.error && j.error.message) || ''}`.trim());
    const usage = j.usage || {}, cost = (usage.input_tokens || 0) * PRICE.in + (usage.output_tokens || 0) * PRICE.out;
    if (j.stop_reason === 'refusal') return { fits: false, warning: true, reason: 'model refused to rate the screen', cost };
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try { return { ...JSON.parse(text.match(/\{[\s\S]*\}/)[0]), cost }; }
    catch { return { fits: false, warning: true, reason: 'unreadable rating: ' + text.slice(0, 60), cost }; }   // im Zweifel anhalten
  } finally { clearTimeout(timer); }
}
const canRate = () => FAKE_JUDGE !== undefined || !!process.env.ANTHROPIC_API_KEY;

// ---------- Zustand (DATA/warmup.json): Einstellungen, Tagesplan, Erledigtes, Alarme ----------
const FILE = path.join(DATA, 'warmup.json');
fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
const fresh = () => ({ window: ['09:00', '23:00'], template: TEMPLATE, phones: {}, alerts: {}, day: null, plan: [], done: {} });
let st; try { st = { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { st = fresh(); }
st.plan.forEach(e => { if (e.status === 'running') e.status = 'stopped'; });   // Sitzung lief, als der Dienst beendet wurde
const save = () => fs.writeFileSync(FILE, JSON.stringify(st, null, 2) + '\n');
const log = o => fs.appendFileSync(path.join(DATA, 'logs', 'scroll.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...o }) + '\n');
const tplFor = day => (day && day <= st.template.length) ? st.template[day - 1] : null;
const active = new Map();                             // Handy-Id -> laufende Sitzung

function notify(text) {
  if (process.platform !== 'darwin') return;
  spawn('osascript', ['-e', `display notification ${JSON.stringify(String(text).slice(0, 200))} with title "phone-lab"`], { stdio: 'ignore' }).on('error', () => {});
}
function alert(id, reason, by) {
  if (st.alerts[id]) return;
  const name = (devById(id) || { name: 'Phone ' + id }).name;
  st.alerts[id] = { at: new Date().toISOString(), reason, by }; save();
  fs.appendFileSync(path.join(DATA, 'logs', 'alerts.log'), `${new Date().toISOString()} ${name} ${by} ${reason}\n`);
  notify(`${name}: ${reason}`);
  const c = active.get(String(id)); if (c) c.abort = 'alert: ' + reason;
}

// Tagesplan: je aktivem Handy die Sitzungen des Warmup-Tags, zufällig im Zeitfenster, mindestens 90 min Abstand.
// Nach einem Neustart mitten am Tag nur noch das Restfenster und die offenen Minuten; erledigte und laufende Einträge bleiben.
function planDay() {
  const today = localDay(), [w0, w1] = st.window.map(hm), from = Math.max(w0, Math.ceil(nowMin()) + 1);
  if (st.doneDay !== today) { st.doneDay = today; st.done = {}; st.plan = []; }
  st.day = today;
  const plan = st.plan.filter(e => e.status !== 'planned');
  for (const dev of devices) {
    const cfg = st.phones[dev.id], tpl = cfg && !cfg.paused ? tplFor(dayIndex(cfg.start, today)) : null;
    if (!tpl || !tpl.scroll || st.alerts[dev.id]) continue;
    const running = active.has(String(dev.id)) ? active.get(String(dev.id)).minutes : 0;
    const left = tpl.scroll - ((st.done[dev.id] || {}).scrollMin || 0) - running;
    if (left < 5 || w1 - from < 25) continue;
    const n = Math.max(1, Math.min(tpl.sessions, Math.floor((w1 - from) / 90) + 1));
    const w = Array.from({ length: n }, () => rnd(0.7, 1.3)), ws = w.reduce((a, b) => a + b, 0), starts = [];
    for (let tries = 0; starts.length < n && tries < 300; tries++) {
      const t = Math.round(rnd(from, w1 - 20));
      if (starts.every(s => Math.abs(s - t) >= 90)) starts.push(t);
    }
    starts.sort((a, b) => a - b).forEach((t, i) => plan.push({ id: dev.id, start: t, minutes: Math.max(5, Math.round(left * w[i] / ws)), status: 'planned' }));
  }
  st.plan = plan.sort((a, b) => a.start - b.start); save();
}

// ---------- Scroll-Sitzung, nur über die Befehle des Servers ----------
async function runSession(id, minutes, entry) {
  id = String(id);
  if (active.has(id)) return;
  const dev = devById(id);
  const niche = (st.phones[id] || {}).niche || '';
  const c = { abort: null, since: Date.now(), minutes, reels: 0, fitting: 0, cost: 0 };
  active.set(id, c);
  const stats = { pausen: 0, zurueck: 0 };
  const end = Date.now() + minutes * rnd(0.9, 1.1) * 60000;
  let reason = 'time up', checkedAt = 0;
  // ein Befehl an den Server; 409 heißt: ein Mensch hält das Handy
  const cmd = async (action, body) => {
    if (c.abort) throw new Error(c.abort);
    const r = await server('POST', `/cmd/${id}/${action}`, body || {});
    const j = r.json();
    if (r.status === 409) { c.abort = 'VA took over (' + (j.error || '') + ')'; throw new Error(c.abort); }
    if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
  };
  // warten, dabei alle 3 s nachsehen, ob ein Mensch übernommen hat
  const wait = async ms => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (c.abort) throw new Error(c.abort);
      if (Date.now() - checkedAt > 3000) {
        checkedAt = Date.now(); await loadDevices();
        const d = devById(id);
        if (d && d.lockedBy) { c.abort = `VA ${d.lockedBy} took over`; throw new Error(c.abort); }
        if (d && !d.ready) { c.abort = 'phone not ready'; throw new Error(c.abort); }
      }
      await sleep(Math.min(500, until - Date.now()));
    }
  };
  const look = async () => {
    const r = await server('GET', `/frame/${id}`, undefined, 8000);
    if (r.status !== 200) throw new Error('no frame');
    const j = await judge(r.buf, niche, id);
    c.cost += j.cost || 0;
    if (j.warning) { alert(id, 'Claude saw a warning: ' + j.reason, 'claude'); throw new Error('warning'); }
    return !!j.fits;
  };
  if (entry) { entry.status = 'running'; save(); }
  try {
    await cmd('launch', { app: 'Instagram' });
    await wait(rnd(2500, 5000));
    await cmd('tap', { x: 0.333 + rnd(-0.02, 0.02), y: 0.937 + rnd(-0.01, 0.01) });     // Reels-Reiter in der Leiste unten
    await wait(rnd(2000, 4000));
    log({ handy: +id, ereignis: 'start', minuten: minutes, niche });
    while (Date.now() < end) {
      const fits = await look(); if (fits) c.fitting++;
      await wait(dwell(fits));
      if (Math.random() < 0.08) { stats.pausen++; await wait(rnd(20000, 90000)); }
      if (Math.random() < 0.03) { stats.zurueck++; await cmd('swipe', { path: swipePath(+1) }); await wait(rnd(2000, 6000)); }
      await cmd('swipe', { path: swipePath(-1) }); c.reels++;
      await wait(rnd(300, 900));
    }
  } catch (e) { reason = e.message; }
  const took = (Date.now() - c.since) / 60000;
  if (!/took over/.test(reason)) await server('POST', `/cmd/${id}/home`, {}).catch(() => {});
  active.delete(id);
  const d = st.done[id] = st.done[id] || { scrollMin: 0, cost: 0, sessions: 0 };
  d.scrollMin = Math.round((d.scrollMin + took) * 10) / 10; d.cost = Math.round((d.cost + c.cost) * 1e5) / 1e5; d.sessions++;
  if (entry) entry.status = reason === 'time up' ? 'done' : 'stopped';
  save();
  log({ handy: +id, name: dev && dev.name, ereignis: 'ende', grund: reason, reels: c.reels, passend: c.fitting, dauer_min: +took.toFixed(1), kosten_usd: +c.cost.toFixed(5), ...stats });
}

// ---------- Takt: Plan abarbeiten ----------
async function tick() {
  await loadDevices();
  if (st.day !== localDay()) planDay();
  const now = nowMin(), w1 = hm(st.window[1]);
  for (const e of st.plan) {
    if (e.status !== 'planned' || e.start > now) continue;
    const d = devById(e.id);
    if (!d || st.alerts[e.id] || !canRate()) { e.status = 'skipped'; continue; }
    if (!d.ready || d.lockedBy || active.has(String(e.id))) {       // belegt oder nicht bereit: in 10 min nochmal
      if (now + 10 < w1 - 5) e.start = Math.round(now + 10); else e.status = 'skipped';
      continue;
    }
    runSession(e.id, e.minutes, e);
  }
  save();
}

// ---------- Sicht für das Dashboard ----------
function view(dev) {
  const id = String(dev.id), cfg = st.phones[id] || {}, day = dayIndex(cfg.start), tpl = tplFor(day), c = active.get(id), t = dev.today || {};
  return {
    start: cfg.start || null, niche: cfg.niche || '', paused: !!cfg.paused,
    day, of: st.template.length, finished: !!(day && day > st.template.length), today: tpl,
    done: { ...(st.done[id] || { scrollMin: 0, cost: 0, sessions: 0 }), likes: t.likes || 0, comments: t.comments || 0 },
    sessions: st.plan.filter(e => String(e.id) === id).map(e => ({ at: fmtHm(e.start), minutes: e.minutes, status: e.status })),
    alert: st.alerts[id] || null,
    claude: c ? { since: c.since, minutes: c.minutes, reels: c.reels, fitting: c.fitting } : null,
  };
}
const config = () => ({ window: st.window, template: st.template, model: MODEL, hasKey: canRate() });

// ---------- HTTP nur für den Server (Token-Kopf), nur 127.0.0.1 ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
http.createServer(async (req, res) => {
  if (req.headers['x-phonelab-token'] !== token()) return send(res, 403, { error: 'only through the phone-lab server' });
  const admin = req.headers['x-phonelab-admin'] === '1';
  let allowedIds; try { allowedIds = JSON.parse(req.headers['x-phonelab-devices'] || '[]'); } catch { allowedIds = []; }
  const may = id => admin || allowedIds === 'all' || (Array.isArray(allowedIds) && allowedIds.includes(+id));
  const [, a, idStr, action] = req.url.split('?')[0].split('/');
  if (req.method === 'GET' && a === 'phones') {
    await loadDevices();
    return send(res, 200, { config: config(), phones: Object.fromEntries(devices.filter(d => may(d.id)).map(d => [d.id, view(d)])) });
  }
  if (req.method === 'POST' && a === 'config') {
    if (!admin) return send(res, 403, { error: 'admins only' });
    const b = await readBody(req);
    if (b.phone !== undefined) {
      const cur = st.phones[b.phone] || {};
      if (b.start !== undefined) cur.start = b.start && /^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : null;
      if (b.niche !== undefined) cur.niche = String(b.niche).slice(0, 200);
      if (b.paused !== undefined) cur.paused = !!b.paused;
      st.phones[b.phone] = cur;
    } else {
      if (Array.isArray(b.window) && b.window.every(s => /^\d{2}:\d{2}$/.test(s)) && hm(b.window[0]) < hm(b.window[1])) st.window = b.window;
      if (Array.isArray(b.template) && b.template.length >= 1 && b.template.length <= 60) st.template = b.template.map(t => ({
        scroll: clamp(+t.scroll || 0, 0, 240), sessions: clamp(Math.round(+t.sessions || 1), 1, 6),
        likes: clamp(Math.round(+t.likes || 0), 0, 200), comments: clamp(Math.round(+t.comments || 0), 0, 50), post: !!t.post }));
    }
    st.day = null; save();                       // Plan neu rechnen
    return send(res, 200, { ok: true, ...config() });
  }
  if (req.method === 'POST' && a === 'phones' && devById(idStr) && may(idStr)) {
    if (action === 'stop') { const c = active.get(idStr); if (c) c.abort = `VA ${req.headers['x-phonelab-user']} took over`; return send(res, 200, { ok: true }); }
    if (!admin) return send(res, 403, { error: 'admins only' });
    if (action === 'clear') { delete st.alerts[idStr]; st.day = null; save(); return send(res, 200, { ok: true }); }
    if (action === 'run') {
      if (!canRate()) return send(res, 409, { ok: false, error: 'ANTHROPIC_API_KEY missing in .env: without Claude rating the screen there is no warning detection' });
      if (active.has(idStr)) return send(res, 409, { ok: false, error: 'a session is already running' });
      const d = devById(idStr);
      if (!d.ready) return send(res, 409, { ok: false, error: `${d.name} is not ready` });
      if (d.lockedBy) return send(res, 409, { ok: false, error: `${d.name} is in use by ${d.lockedBy}` });
      runSession(idStr, Math.min(60, Math.max(1, +(await readBody(req)).minutes || 10)), null);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Warmup-Dienst auf 127.0.0.1:${PORT}, Server ${SERVER}, Bewertung ${canRate() ? MODEL : 'fehlt (kein ANTHROPIC_API_KEY)'}`));

// erst starten, wenn der Server sein Dienst-Token angelegt hat
(async () => {
  while (!fs.existsSync(TOKEN_FILE)) await sleep(2000);
  setInterval(() => tick().catch(e => console.log('tick:', e.message)), 30000);
  setTimeout(() => tick().catch(() => {}), 3000);
})();
