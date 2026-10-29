#!/usr/bin/env node
// Ende-zu-Ende-Test ohne iPhone: startet test/fake-wda.js, den Server (PHONELAB_FAKE=1) und den Warmup-Dienst als eigene
// Prozesse mit eigenem Datenordner. Prüft Fernsteuerung (Warteschlange, Sperre, busy), den Dienstzugang (Mensch geht vor)
// und den Warmup nur über die Durchreichung /agent/*.
// Aufruf: node test/e2e.js     (Ports 3000, 3001 und die aus devices.json müssen frei sein)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'phonelab-e2e-'));
const B = 'http://127.0.0.1:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

const mkUser = (name, pw, admin) => { const salt = crypto.randomBytes(16); return { name, salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex'), admin, devices: 'all' }; };
fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify({ users: [mkUser('admin', 'testpassword1', true), mkUser('va1', 'testpassword2', false)] }));

const procs = {};
const start = (key, file, env) => { const p = spawn(process.execPath, [path.join(ROOT, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d); procs[key] = p; return p; };
start('fake', 'test/fake-wda.js', { FAKE_SLOW: '5' });
start('server', 'server.js', { PHONELAB_FAKE: '1', PHONELAB_DATA: DATA });
start('agent', 'warmup.js', { PHONELAB_DATA: DATA, WARMUP_FAKE_JUDGE: '3', ANTHROPIC_API_KEY: '' });

let failed = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!cond) failed++; };
async function login(name, pw) {
  const r = await fetch(B + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ name, pw }) });
  return /pl=[a-f0-9]+/.exec(r.headers.get('set-cookie') || '')[0];
}
const api = (cookie) => ({
  get: p => fetch(B + p, { headers: { cookie } }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) })),
  post: (p, b) => fetch(B + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, ...(await r.json()) })),
});
const stats = id => fetch(`http://127.0.0.1:${CFG.devices.find(d => d.id === id).wda_port}/fake/stats`).then(r => r.json()).then(j => j.value);
const phone = async (a, id) => (await a.get('/devices')).devices.find(d => d.id === id);
const wu = async (a, id) => (await a.get('/agent/phones')).phones[id];
const swipe = { path: [{ x: 0.5, y: 0.8, t: 0 }, { x: 0.5, y: 0.2, t: 200 }] };

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/'); break; } catch { await sleep(200); } }
    const admin = api(await login('admin', 'testpassword1')), va = api(await login('va1', 'testpassword2'));
    for (let i = 0; i < 30 && !(await admin.get('/devices')).devices.every(d => d.ready); i++) await sleep(500);
    ok((await admin.get('/devices')).devices.every(d => d.ready), 'alle Handys bereit');

    // 1 Fernsteuerung: 10 gleichzeitige Tipps kommen einzeln nacheinander an
    const t0 = Date.now();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => admin.post('/cmd/1/tap', { x: 0.1 * i, y: 0.5 })));
    ok(res.every(r => r.ok), '10 Tipps ok');
    ok((await stats(1)).maxParallel === 1, 'nie zwei Aufrufe gleichzeitig an WDA');
    ok(Date.now() - t0 >= 1400, '10 x 150 ms nacheinander', Date.now() - t0);
    const auto = await Promise.all(Array.from({ length: 6 }, () => admin.post('/cmd/1/swipe', { auto: true, ...swipe })));
    ok(auto.filter(r => r.skipped).length >= 4, 'Auto-Wische bei Stau verworfen', auto.map(r => r.skipped ? 's' : 'x').join(''));

    // 2 busy: Handy 5 braucht 10 s je Eingabe; der zweite Befehl kommt nicht binnen 8 s dran und läuft auch später nicht
    const first = admin.post('/cmd/5/tap', { x: 0.1, y: 0.1 });
    await sleep(200);
    const t1 = Date.now(), second = await admin.post('/cmd/5/tap', { x: 0.9, y: 0.9 });
    ok(!second.ok && /busy/.test(second.error) && Date.now() - t1 < 9000, 'zweiter Befehl meldet busy nach höchstens 8 s', { ms: Date.now() - t1, error: second.error });
    await first; await sleep(500);
    ok((await stats(5)).calls === 1, 'verworfener Befehl wurde nicht nachträglich ausgeführt', (await stats(5)).calls);

    // 3 Server ohne Warmup: /devices hat Tageszähler, aber keine Warmup-Daten
    const d1 = await phone(admin, 1);
    ok(d1.today && d1.warmup === undefined, '/devices: today-Zähler, kein Warmup im Server', d1.today);
    ok((await admin.get('/frame/1')).status !== 404 && (await fetch(B + '/frame/1', { headers: { cookie: (await login('admin', 'testpassword1')) } })).headers.get('content-type') === 'image/jpeg', '/frame liefert ein JPEG');

    // 4 Warmup über die Durchreichung
    ok((await admin.post('/agent/config', { window: ['00:00', '23:59'] })).ok, 'Zeitfenster gesetzt (über /agent)');
    for (const id of [2, 3, 4]) await admin.post('/agent/config', { phone: id, start: today, niche: 'Gaming, Cosplay' });
    ok((await va.post('/agent/config', { phone: 2, paused: true })).status === 403, 'VA darf den Warmup nicht ändern');
    await sleep(31000);   // ein Takt des Dienstes
    const w2 = await wu(admin, 2);
    ok(w2.day === 1 && w2.today.scroll === 40, 'Tag 1 mit 40 min Scroll', { day: w2.day, today: w2.today });
    ok(w2.sessions.length >= 1, 'Sitzungen für heute geplant', w2.sessions);
    ok((await fetch('http://127.0.0.1:3001/phones')).status === 403, 'Dienst nimmt direkte Anfragen ohne Server-Token nicht an');

    // 5 Claude-Sitzung, Mensch übernimmt
    ok((await admin.post('/agent/phones/2/run', { minutes: 2 })).ok, 'Sitzung auf Handy 2 gestartet');
    await sleep(9000);
    const run = await phone(admin, 2), runW = await wu(admin, 2);
    ok(runW.claude && run.lockedBy === 'claude', 'Handy 2 vom Dienst "claude" gehalten', { claude: runW.claude, lockedBy: run.lockedBy });
    ok((await stats(2)).app === 'com.burbn.instagram', 'Instagram geöffnet (über /cmd/launch)');
    const take = await va.post('/cmd/2/tap', { x: 0.5, y: 0.5 });
    ok(take.ok, 'VA übernimmt sofort, kein 409', take);
    await sleep(4500);
    ok(!(await wu(admin, 2)).claude && (await phone(admin, 2)).lockedBy === 'va1', 'Dienst hat abgegeben, Handy gehört va1');
    const log = fs.readFileSync(path.join(DATA, 'logs', 'scroll.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    ok(log.some(l => l.handy === 2 && l.ereignis === 'ende' && /took over/.test(l.grund)), 'Ende "took over" im Log', log.slice(-1)[0]);
    ok((await admin.post('/cmd/2/tap', { x: 0.5, y: 0.5 })).status === 409, 'zweiter Mensch bekommt 409');
    ok((await admin.post('/agent/phones/2/run', { minutes: 2 })).status === 409, 'Dienst startet nicht, solange ein Mensch hält');

    // 6 Warnung: Handy 3 zeigt laut Bewertung eine Warnung
    await admin.post('/agent/phones/3/run', { minutes: 2 });
    await sleep(10000);
    const w3 = await wu(admin, 3);
    ok(w3.alert && !w3.claude, 'Alarm auf Handy 3, Sitzung beendet', w3.alert);
    ok((await stats(3)).app === 'com.apple.springboard', 'Handy 3 zurück auf dem Homescreen');
    ok(fs.readFileSync(path.join(DATA, 'logs', 'alerts.log'), 'utf8').includes('Phone 3'), 'alerts.log geschrieben');
    await admin.post('/agent/phones/3/clear');
    ok(!(await wu(admin, 3)).alert, 'Alarm quittiert');

    // 7 VA-Zähler
    await va.post('/cmd/4/doubletap', { x: 0.5, y: 0.5 }); await va.post('/cmd/4/doubletap', { x: 0.5, y: 0.5 });
    await va.post('/cmd/4/keys', { text: 'so cool\n' }); await va.post('/cmd/4/text', { text: 'nice' });
    await sleep(5500);
    const w4 = await wu(admin, 4);
    ok(w4.done.likes === 2 && w4.done.comments === 2, 'Likes 2, Kommentare 2 auf Handy 4', w4.done);

    // 8 Stream und Insights
    const ctl = new AbortController(); let bytes = 0;
    const sr = await fetch(B + '/stream/1', { headers: { cookie: (await login('admin', 'testpassword1')) }, signal: ctl.signal });
    const rd = sr.body.getReader(); const until = Date.now() + 1500;
    while (Date.now() < until) { const { value, done } = await rd.read(); if (done) break; bytes += value.length; }
    ctl.abort();
    ok(bytes > 20000, 'Stream liefert Bilder', bytes);
    const ins = await admin.get('/insights');
    ok(ins.today.length > 0 && ins.devices.length === CFG.devices.length, 'Insights ok');

    // 9 Dienst aus: Fernsteuerung läuft weiter, /agent antwortet 503
    procs.agent.kill(); await sleep(800);
    ok((await admin.get('/agent/phones')).status === 503, 'ohne Dienst: /agent antwortet 503');
    ok((await va.post('/cmd/4/tap', { x: 0.5, y: 0.5 })).ok, 'ohne Dienst: Fernsteuerung geht weiter');
  } catch (e) { console.log('FAIL Ausnahme:', e.stack); failed++; }
  finally {
    if (failed) console.log('--- Server ---\n' + procs.server.out.slice(-2000) + '\n--- Dienst ---\n' + procs.agent.out.slice(-2000));
    Object.values(procs).forEach(p => p.kill());
    console.log(failed ? `${failed} Fehler` : 'alles ok');
    process.exit(failed ? 1 : 0);
  }
})();
