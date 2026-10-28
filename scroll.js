#!/usr/bin/env node
// Scroll-Sitzung: schaut Reels in menschlichem Tempo. Nur wischen, nie tippen außer zum Öffnen von Reels.
// Keine Likes, Kommentare, Follows, Profile. Stoppt sofort bei Hinweisen auf Captcha, Sperre oder ungewöhnliche Aktivität.
// Aufruf: node scroll.js <handyId> [minuten] [--niche "Gaming, Cosplay"] [--dry]
// Mit --niche bewertet Claude je Reel per Screenshot, ob es zur Nische passt; passende Reels werden länger angeschaut.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const NICHE = args.includes('--niche') ? args[args.indexOf('--niche') + 1] : null;
const ID = args.find(a => /^\d+$/.test(a)) || '1';
const MINUTES = +(args.filter(a => /^\d+$/.test(a))[1] || 15);
const INSTAGRAM = 'com.burbn.instagram';
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const dev = CFG.devices.find(d => String(d.id) === ID);
if (!dev && !DRY) { console.error('unbekanntes Handy ' + ID); process.exit(1); }
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

// Wörter, bei denen sofort Schluss ist (Instagram-Hinweise auf Prüfung, Sperre, Captcha)
const STOP_WORDS = /ungewöhnlich|unusual|captcha|bestätige, dass du|confirm it.s you|vorübergehend gesperrt|temporarily blocked|versuch es später|try again later|automatisier|automated|verdächtig|suspicious|konto gesperrt|account has been|hilf uns|help us confirm|challenge_required|checkpoint/i;

// ---------- Zufall mit menschlicher Verteilung ----------
const rnd = (a, b) => a + Math.random() * (b - a);
const lognormal = (median, sigma) => median * Math.exp(sigma * (Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random())));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wischweg wie mit dem Daumen: Start unten mittig, leicht schräg. Immer entschieden: mindestens halber Bildschirm,
// Schwung bis zum Loslassen, damit Reels sicher zum nächsten Video springt und nie halb stehen bleibt.
function swipePath(dir = -1) {
  const x0 = rnd(0.35, 0.65), y0 = dir < 0 ? rnd(0.7, 0.85) : rnd(0.15, 0.3);
  const len = rnd(0.55, 0.7), drift = rnd(-0.05, 0.05), bend = rnd(-0.03, 0.03);
  const total = rnd(160, 300);
  const n = 5 + Math.floor(rnd(0, 4));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, e = 1 - Math.pow(1 - u, 1.5);     // zügig, am Ende noch in Bewegung
    pts.push({ x: clamp(x0 + drift * e + bend * Math.sin(Math.PI * e), 0.05, 0.95), y: clamp(y0 + dir * len * e, 0.05, 0.95), t: Math.round(total * u + rnd(-6, 6)) });
  }
  pts[0].t = 0;
  for (let i = 1; i < pts.length; i++) pts[i].t = Math.max(pts[i].t, pts[i - 1].t + 10);
  return pts;
}
// Verweildauer je Reel: Median 6 s, breit gestreut; passende Reels Median 16 s
const dwell = fits => clamp(lognormal(fits ? 16 : 6, 0.7), 1.5, fits ? 70 : 40) * 1000;

// ---------- WDA ----------
function wda(method, p, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: dev.wda_port, method, path: p, timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { const j = JSON.parse(buf); if (j.value && j.value.error) return reject(new Error(j.value.error)); resolve(j); } catch { reject(new Error('WDA: keine JSON-Antwort')); } });
    });
    req.on('timeout', () => req.destroy(new Error('WDA: Timeout'))); req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}
let sid, W, H;
async function session() {
  const st = await wda('GET', '/status');
  sid = st.sessionId || (await wda('POST', '/session', { capabilities: { alwaysMatch: {} } })).sessionId;
  const size = (await wda('GET', `/session/${sid}/window/size`)).value; W = size.width; H = size.height;
  await wda('POST', `/session/${sid}/appium/settings`, { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } }).catch(() => {});
}
const px = p => ({ x: Math.round(p.x * W), y: Math.round(p.y * H) });
async function swipe(pts) {
  const steps = [{ type: 'pointerMove', duration: 0, ...px(pts[0]) }, { type: 'pointerDown', button: 0 }];
  for (let i = 1; i < pts.length; i++) steps.push({ type: 'pointerMove', duration: Math.max(10, pts[i].t - pts[i - 1].t), ...px(pts[i]) });
  steps.push({ type: 'pointerUp', button: 0 });
  return wda('POST', `/session/${sid}/actions`, { actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions: steps }] });
}
const activeApp = async () => (await wda('GET', `/session/${sid}/wda/activeAppInfo`)).value.bundleId;
// Bildschirmtext über den Accessibility-Baum (kein Bild nötig), für die Stoppwörter
const screenText = async () => (await wda('GET', `/session/${sid}/source?format=xml`, undefined, 30000)).value || '';
// Ein JPEG-Bild aus dem MJPEG-Strom (klein, reicht für die Bewertung)
function frame() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: dev.mjpeg_port, path: '/', timeout: 5000 }, res => {
      let buf = Buffer.alloc(0);
      res.on('data', c => {
        buf = Buffer.concat([buf, c]);
        const s = buf.indexOf(Buffer.from([0xff, 0xd8])), e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
        if (s >= 0 && e > s) { req.destroy(); resolve(buf.subarray(s, e + 2)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('kein Bild'))); req.on('error', reject);
  });
}
// Reels-Reiter über den Accessibility-Namen finden, Fallback: feste Position in der Leiste unten
async function openReels() {
  await wda('POST', `/session/${sid}/wda/apps/launch`, { bundleId: INSTAGRAM });
  await sleep(rnd(2500, 5000));
  let tapped = false;
  try {
    const el = (await wda('POST', `/session/${sid}/element`, { using: '-ios predicate string', value: "name == 'reels-tab' OR label == 'Reels' OR name == 'Reels'" })).value;
    const rect = (await wda('GET', `/session/${sid}/element/${el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf']}/rect`)).value;
    await tap((rect.x + rect.width / 2) / W, (rect.y + rect.height / 2) / H); tapped = true;
  } catch {}
  if (!tapped) await tap(0.333 + rnd(-0.02, 0.02), 0.937 + rnd(-0.01, 0.01));
  await sleep(rnd(2000, 4000));
}
async function tap(x, y) {
  return wda('POST', `/session/${sid}/actions`, { actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, ...px({ x, y }) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: Math.round(rnd(40, 120)) }, { type: 'pointerUp', button: 0 }] }] });
}

// ---------- Claude: passt das Reel zur Nische? Zeigt der Bildschirm eine Warnung? ----------
let claude = null;
async function judge(jpeg) {
  if (!claude) { const Anthropic = require('@anthropic-ai/sdk'); claude = new Anthropic(); }
  const res = await claude.beta.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5', max_tokens: 256,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: 'Du bewertest Screenshots einer Instagram-Reels-Ansicht. Antworte nur mit JSON: {"fits": true|false, "warning": true|false, "reason": "kurz"}. fits = Inhalt passt zur genannten Nische. warning = Bildschirm zeigt Captcha, Sperre, Hinweis auf ungewöhnliche Aktivität, Login-Aufforderung oder einen Dialog, der kein normales Reel ist.',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } }, { type: 'text', text: `Nische: ${NICHE}` }] }],
  });
  if (res.stop_reason === 'refusal') return { fits: false, warning: false, reason: 'refusal' };
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch { return { fits: false, warning: false, reason: 'unlesbar: ' + text.slice(0, 60) }; }
}

// ---------- Sitzung ----------
const log = o => { const line = JSON.stringify({ time: new Date().toISOString(), handy: ID, ...o }); console.log(line); fs.appendFileSync(path.join(ROOT, 'logs', 'scroll.jsonl'), line + '\n'); };

async function run() {
  const minutes = MINUTES * rnd(0.85, 1.15), end = Date.now() + minutes * 60000;
  let reels = 0, fitting = 0, reason = 'Zeit um';
  const stats = { pausen: 0, zurueck: 0, warnung: 0 };
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const stop = r => { reason = r; return false; };
  try {
    await session();
    await openReels();
    if (STOP_WORDS.test(await screenText())) throw new Error('Stoppwort beim Start');
    log({ ereignis: 'start', minuten: +minutes.toFixed(1), niche: NICHE });
    while (Date.now() < end) {
      let fits = false;
      if (NICHE) {
        const j = await judge(await frame()).catch(e => ({ fits: false, warning: false, reason: 'Claude-Fehler: ' + e.message }));
        if (j.warning) { stats.warnung++; stop('Warnung laut Claude: ' + j.reason); break; }
        fits = !!j.fits; if (fits) fitting++;
      }
      await sleep(dwell(fits));
      if (Math.random() < 0.08) { stats.pausen++; await sleep(rnd(20000, 90000)); }        // abgelenkt
      if (reels % 4 === 3) {
        if (await activeApp() !== INSTAGRAM) { stop('Instagram nicht mehr im Vordergrund'); break; }
        if (STOP_WORDS.test(await screenText())) { stop('Stoppwort auf dem Bildschirm'); break; }
      }
      if (Math.random() < 0.03) { stats.zurueck++; await swipe(swipePath(+1)); await sleep(rnd(2000, 6000)); }   // nochmal das vorige
      await swipe(swipePath(-1)); reels++;
      await sleep(rnd(300, 900));                                                              // Video lädt, Auge sucht
    }
  } catch (e) { reason = 'Fehler: ' + e.message; }
  await wda('POST', '/wda/homescreen').catch(() => {});
  log({ ereignis: 'ende', grund: reason, reels, passend: fitting, anteil_passend: reels ? +(fitting / reels).toFixed(2) : null, dauer_min: +((Date.now() - (end - minutes * 60000)) / 60000).toFixed(1), ...stats });
  if (reason.startsWith('Warnung') || reason.startsWith('Stoppwort')) process.exitCode = 2;
}

if (args.includes('--swipetest')) { // 5 Wische, je ein Screenshot danach, zum Prüfen ob das Bild ganz ist
  (async () => {
    await session(); await openReels();
    const out = args[args.indexOf('--swipetest') + 1];
    for (let i = 1; i <= 5; i++) {
      await swipe(swipePath(-1)); await sleep(1200);
      fs.writeFileSync(`${out}/swipe${i}.png`, Buffer.from((await wda('GET', '/screenshot')).value, 'base64'));
      await sleep(rnd(1500, 3000));
    }
    await wda('POST', '/wda/homescreen'); console.log('5 Screenshots in', out);
  })();
} else if (DRY) { // Selbsttest ohne Gerät: Verteilungen prüfen
  const d = Array.from({ length: 2000 }, () => dwell(false) / 1000).sort((a, b) => a - b);
  const p = swipePath(-1), back = swipePath(+1);
  const assert = (ok, msg) => { if (!ok) { console.error('FEHLER:', msg); process.exit(1); } };
  assert(p.every(q => q.x >= 0.05 && q.x <= 0.95 && q.y >= 0.05 && q.y <= 0.95), 'Wischweg außerhalb');
  assert(p[0].y - p[p.length - 1].y > 0.5, 'Wisch nach oben zu kurz');
  assert(back[back.length - 1].y - back[0].y > 0.5, 'Wisch nach unten zu kurz');
  assert(p.every((q, i) => i === 0 || q.t >= p[i - 1].t), 'Zeiten nicht aufsteigend');
  assert(d[1000] > 4 && d[1000] < 9, 'Median Verweildauer unplausibel: ' + d[1000]);
  console.log('Verweildauer s: min', d[0].toFixed(1), 'median', d[1000].toFixed(1), 'p90', d[1800].toFixed(1), 'max', d[1999].toFixed(1));
  console.log('Wischweg:', p.map(q => `(${q.x.toFixed(2)},${q.y.toFixed(2)})@${q.t}ms`).join(' '));
  console.log('dry ok');
} else run();
