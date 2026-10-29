'use strict';
// Warmup je Handy: 14-Tage-Plan, Scroll-Sitzungen durch Claude, Aufgaben für die VA, Wächter gegen Captcha und Sperrhinweise.
// Claude wischt nur. Keine Likes, Kommentare, Follows, DMs, Profilbesuche (BRIEF.md). Likes und Kommentare macht die VA von Hand.
// Läuft im Server-Prozess, alle WDA-Aufrufe gehen über dessen Warteschlange je Handy (api.exec).
const fs = require('fs');
const path = require('path');

const INSTAGRAM = 'com.burbn.instagram';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const PRICE = { in: 0.10 / 1e6, out: 0.50 / 1e6 };          // Haiku 5.5, $ je Token
// Wörter, bei denen sofort Schluss ist (Instagram-Hinweise auf Prüfung, Sperre, Captcha)
const STOP_WORDS = /ungewöhnlich|unusual|captcha|bestätige, dass du|confirm it.s you|vorübergehend gesperrt|temporarily blocked|versuch es später|try again later|automatisier|automated|verdächtig|suspicious|konto gesperrt|account has been|hilf uns|help us confirm|challenge_required|checkpoint/i;

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
// Warmup-Tag: 1 am Startdatum, null vor dem Start
function dayIndex(start, today = localDay()) {
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
// Verweildauer je Reel: Median 6 s, passende Reels Median 16 s
const dwell = fits => clamp(lognormal(fits ? 16 : 6, 0.7), 1.5, fits ? 70 : 40) * 1000;

// ---------- Claude: passt das Reel zur Nische, zeigt der Bildschirm eine Warnung? ----------
// Direkter HTTP-Aufruf, weil der Server ohne Zusatzpakete läuft. Effort low ohne Denken: zwei Ja/Nein-Fragen brauchen keins.
async function judge(jpeg, niche) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY fehlt in .env');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': key.replace(/[^\x21-\x7E]/g, ''), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 200,
        thinking: { type: 'disabled' }, output_config: { effort: 'low' },
        system: 'You rate screenshots of the Instagram Reels view. Reply with JSON only: {"fits": true|false, "warning": true|false, "reason": "short"}. fits = the content matches the given niche. warning = the screen shows a captcha, a block or restriction notice, an unusual-activity notice, a login prompt, or any dialog that is not a normal reel.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: `Niche: ${niche}` }] }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`API ${r.status}: ${(j.error && j.error.message) || ''}`.trim());
    const usage = j.usage || {}, cost = (usage.input_tokens || 0) * PRICE.in + (usage.output_tokens || 0) * PRICE.out;
    if (j.stop_reason === 'refusal') return { fits: false, warning: false, reason: 'refusal', cost };
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try { return { ...JSON.parse(text.match(/\{[\s\S]*\}/)[0]), cost }; }
    catch { return { fits: false, warning: false, reason: 'unreadable: ' + text.slice(0, 60), cost }; }
  } finally { clearTimeout(timer); }
}

// ---------- Zustand (DATA/warmup.json): Einstellungen, Tagesplan, Erledigtes, Alarme ----------
function create(api) {
  // api: { DATA, devices, exec(dev, fn), wda(dev, method, path, body, timeout), session(dev), frame(dev), vaCounts(), notify(text), protokoll(user, text) }
  const FILE = path.join(api.DATA, 'warmup.json');
  const LOG = path.join(api.DATA, 'logs', 'scroll.jsonl');
  const fresh = () => ({ window: ['09:00', '23:00'], template: TEMPLATE, phones: {}, alerts: {}, day: null, plan: [], done: {} });
  let st; try { st = { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { st = fresh(); }
  st.plan.forEach(e => { if (e.status === 'running') e.status = 'stopped'; });   // Sitzung lief, als der Server beendet wurde
  const save = () => fs.writeFileSync(FILE, JSON.stringify(st, null, 2) + '\n');
  const log = o => fs.appendFileSync(LOG, JSON.stringify({ time: new Date().toISOString(), ...o }) + '\n');
  const devById = id => api.devices.find(d => String(d.id) === String(id));
  const tplFor = day => (day && day <= st.template.length) ? st.template[day - 1] : null;

  function alert(dev, reason, by) {
    if (st.alerts[dev.id]) return;
    st.alerts[dev.id] = { at: new Date().toISOString(), reason, by }; save();
    fs.appendFileSync(path.join(api.DATA, 'logs', 'alerts.log'), `${new Date().toISOString()} ${dev.name} ${by} ${reason}\n`);
    api.protokoll('warmup', `${dev.name} alert: ${reason}`);
    api.notify(`${dev.name}: ${reason}`);
    if (dev.claude) dev.claude.abort = 'Alarm: ' + reason;
  }

  // Tagesplan: je aktivem Handy die Sitzungen des Warmup-Tags, Startzeiten zufällig im Zeitfenster, mindestens 90 min Abstand.
  // Nach einem Neustart mitten am Tag nur noch das Restfenster und die noch offenen Minuten.
  function planDay() {
    const today = localDay(), [w0, w1] = st.window.map(hm), from = Math.max(w0, Math.ceil(nowMin()) + 1);
    if (st.doneDay !== today) { st.doneDay = today; st.done = {}; st.plan = []; }
    st.day = today;
    // Erledigte und laufende Einträge von heute bleiben stehen, nur offene werden neu verteilt
    const plan = st.plan.filter(e => e.status !== 'planned');
    for (const dev of api.devices) {
      const cfg = st.phones[dev.id], tpl = cfg && !cfg.paused ? tplFor(dayIndex(cfg.start, today)) : null;
      if (!tpl || !tpl.scroll || st.alerts[dev.id]) continue;
      const running = dev.claude ? dev.claude.minutes : 0;
      const left = tpl.scroll - ((st.done[dev.id] || {}).scrollMin || 0) - running;
      if (left < 5 || w1 - from < 25) continue;
      const n = Math.max(1, Math.min(tpl.sessions, Math.floor((w1 - from) / 90) + 1));
      const w = Array.from({ length: n }, () => rnd(0.7, 1.3)), ws = w.reduce((a, b) => a + b, 0);
      const starts = [];
      for (let tries = 0; starts.length < n && tries < 300; tries++) {
        const t = Math.round(rnd(from, w1 - 20));
        if (starts.every(s => Math.abs(s - t) >= 90)) starts.push(t);
      }
      starts.sort((a, b) => a - b).forEach((t, i) => plan.push({ id: dev.id, start: t, minutes: Math.max(5, Math.round(left * w[i] / ws)), status: 'planned' }));
    }
    st.plan = plan.sort((a, b) => a.start - b.start); save();
  }

  // ---------- Scroll-Sitzung ----------
  async function runSession(dev, minutes, entry) {
    if (dev.claude) return;
    const niche = (st.phones[dev.id] || {}).niche || '';
    const c = dev.claude = { abort: null, since: Date.now(), minutes, reels: 0, fitting: 0, cost: 0 };
    const stats = { pausen: 0, zurueck: 0 };
    const end = Date.now() + minutes * rnd(0.9, 1.1) * 60000;
    const x = (fn, label = 'claude') => { if (c.abort) throw new Error(c.abort); dev.lockedBy = 'claude'; dev.lockAt = Date.now(); return api.exec(dev, fn, label); };
    const wait = async ms => { const until = Date.now() + ms; while (Date.now() < until) { if (c.abort) throw new Error(c.abort); await sleep(Math.min(1000, until - Date.now())); } };
    const screenText = () => x(() => api.withSession(dev, sid => api.wda(dev, 'GET', `/session/${sid}/source?format=xml`, undefined, 12000)), 'claude screen text').then(r => r.value || '');
    let reason = 'time up';
    if (entry) { entry.status = 'running'; save(); }
    api.protokoll('claude', `${dev.name} warmup session ${minutes} min`);
    try {
      await x(() => api.cmd.launch(dev, { app: 'Instagram' }));
      await wait(rnd(2500, 5000));
      await x(() => api.cmd.tapReels(dev));
      await wait(rnd(2000, 4000));
      if (STOP_WORDS.test(await screenText())) { alert(dev, 'stop word on screen at start', 'claude'); throw new Error('stop word at start'); }
      log({ handy: dev.id, ereignis: 'start', minuten: minutes, niche });
      while (Date.now() < end) {
        let fits = false;
        if (niche && process.env.ANTHROPIC_API_KEY) {
          const j = await api.frame(dev).then(f => judge(f, niche)).catch(e => ({ fits: false, warning: false, reason: 'claude error: ' + e.message }));
          c.cost += j.cost || 0;
          if (j.warning) { alert(dev, 'Claude saw a warning: ' + j.reason, 'claude'); throw new Error('warning'); }
          fits = !!j.fits; if (fits) c.fitting++;
        }
        await wait(dwell(fits));
        if (Math.random() < 0.08) { stats.pausen++; await wait(rnd(20000, 90000)); }
        if (c.reels % 4 === 3) {
          const app = await x(() => api.withSession(dev, sid => api.wda(dev, 'GET', `/session/${sid}/wda/activeAppInfo`))).then(r => r.value.bundleId);
          if (app !== INSTAGRAM) throw new Error('Instagram no longer in front');
          if (STOP_WORDS.test(await screenText())) { alert(dev, 'stop word on screen', 'claude'); throw new Error('stop word'); }
        }
        if (Math.random() < 0.03) { stats.zurueck++; await x(() => api.cmd.swipe(dev, { path: swipePath(+1) })); await wait(rnd(2000, 6000)); }
        await x(() => api.cmd.swipe(dev, { path: swipePath(-1) })); c.reels++;
        await wait(rnd(300, 900));
      }
    } catch (e) { reason = e.message; }
    const took = (Date.now() - c.since) / 60000;
    if (!/^VA /.test(reason)) await api.exec(dev, () => api.cmd.home(dev)).catch(() => {});
    dev.claude = null; if (dev.lockedBy === 'claude') dev.lockedBy = null;
    const d = st.done[dev.id] = st.done[dev.id] || { scrollMin: 0, cost: 0, sessions: 0 };
    d.scrollMin = Math.round((d.scrollMin + took) * 10) / 10; d.cost = Math.round((d.cost + c.cost) * 1e5) / 1e5; d.sessions++;
    if (entry) entry.status = reason === 'time up' ? 'done' : 'stopped';
    save();
    log({ handy: dev.id, ereignis: 'ende', grund: reason, reels: c.reels, passend: c.fitting, dauer_min: +took.toFixed(1), kosten_usd: +c.cost.toFixed(5), ...stats });
    api.protokoll('claude', `${dev.name} warmup session end (${reason}, ${c.reels} reels)`);
  }

  // ---------- Takt: Plan abarbeiten, Wächter für VA-Bedienung ----------
  async function tick() {
    if (st.day !== localDay()) planDay();
    const now = nowMin(), w1 = hm(st.window[1]);
    for (const e of st.plan) {
      if (e.status !== 'planned' || e.start > now) continue;
      const dev = devById(e.id);
      if (!dev || st.alerts[e.id]) { e.status = 'skipped'; continue; }
      const human = dev.lockedBy && dev.lockedBy !== 'claude' && Date.now() - dev.lockAt < 120000;
      if (!dev.ready || human || dev.claude) {
        if (now + 10 < w1 - 5) e.start = Math.round(now + 10); else e.status = 'skipped';   // später nochmal
        continue;
      }
      runSession(dev, e.minutes, e);
    }
    save();
    // Kein Wächter während eine VA bedient: der Bildschirmtext von Instagram braucht auf dem iPhone viele Sekunden und hielt
    // in der Zeit jede Eingabe der VA in der Warteschlange fest (Focus ließ sich nicht mehr wischen). Die VA sieht den Bildschirm selbst.
  }
  setInterval(() => tick().catch(e => console.log('warmup tick:', e.message)), 30000);
  setTimeout(() => tick().catch(() => {}), 5000);

  // ---------- Sicht für die Oberfläche ----------
  function view(dev) {
    const cfg = st.phones[dev.id] || {}, day = dayIndex(cfg.start), tpl = tplFor(day), va = api.vaCounts()[dev.name] || { likes: 0, comments: 0 };
    return {
      start: cfg.start || null, niche: cfg.niche || '', paused: !!cfg.paused,
      day, of: st.template.length, finished: !!(day && day > st.template.length), today: tpl,
      done: { ...(st.done[dev.id] || { scrollMin: 0, cost: 0, sessions: 0 }), likes: va.likes, comments: va.comments },
      sessions: st.plan.filter(e => e.id === dev.id).map(e => ({ at: fmtHm(e.start), minutes: e.minutes, status: e.status })),
      alert: st.alerts[dev.id] || null,
      claude: dev.claude ? { since: dev.claude.since, minutes: dev.claude.minutes, reels: dev.claude.reels, fitting: dev.claude.fitting } : null,
    };
  }

  return {
    view, alert, runSession,
    config: () => ({ window: st.window, template: st.template, model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY }),
    setPhone(id, b) {
      const cur = st.phones[id] || {};
      if (b.start !== undefined) cur.start = b.start && /^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : null;
      if (b.niche !== undefined) cur.niche = String(b.niche).slice(0, 200);
      if (b.paused !== undefined) cur.paused = !!b.paused;
      st.phones[id] = cur; st.day = null; save();         // Plan neu rechnen
    },
    setGlobal(b) {
      if (Array.isArray(b.window) && b.window.every(s => /^\d{2}:\d{2}$/.test(s)) && hm(b.window[0]) < hm(b.window[1])) st.window = b.window;
      if (Array.isArray(b.template) && b.template.length >= 1 && b.template.length <= 60) st.template = b.template.map(t => ({
        scroll: clamp(+t.scroll || 0, 0, 240), sessions: clamp(Math.round(+t.sessions || 1), 1, 6),
        likes: clamp(Math.round(+t.likes || 0), 0, 200), comments: clamp(Math.round(+t.comments || 0), 0, 50), post: !!t.post }));
      st.day = null; save();
    },
    clearAlert(id) { delete st.alerts[id]; st.day = null; save(); },
    stop(dev, why) { if (dev.claude) dev.claude.abort = why; },
  };
}

module.exports = { create, swipePath, dwell, dayIndex, TEMPLATE, STOP_WORDS };
