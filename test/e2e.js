#!/usr/bin/env node
// Ende-zu-Ende-Test ohne iPhone: startet test/fake-wda.js und den Server im Testbetrieb (PHONELAB_FAKE=1) mit eigenem
// Datenordner und prüft Warteschlange, Auto-Scroll, Warmup, Übernahme durch die VA, Wächter und VA-Zähler.
// Aufruf: node test/e2e.js     (Port 3000 und die Ports aus devices.json müssen frei sein)
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

const procs = [];
const start = (file, env) => { const p = spawn(process.execPath, [path.join(ROOT, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d); procs.push(p); return p; };
const fake = start('test/fake-wda.js', { FAKE_STOP: '3' });
const server = start('server.js', { PHONELAB_FAKE: '1', PHONELAB_DATA: DATA, ANTHROPIC_API_KEY: '' });

let failed = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); if (!cond) failed++; };
async function login(name, pw) {
  const r = await fetch(B + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ name, pw }) });
  return /pl=[a-f0-9]+/.exec(r.headers.get('set-cookie') || '')[0];
}
const api = (cookie) => ({
  get: p => fetch(B + p, { headers: { cookie } }).then(r => r.json()),
  post: (p, b) => fetch(B + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, ...(await r.json()) })),
});
const stats = id => fetch(`http://127.0.0.1:${CFG.devices.find(d => d.id === id).wda_port}/fake/stats`).then(r => r.json()).then(j => j.value);
const phone = async (a, id) => (await a.get('/devices')).devices.find(d => d.id === id);

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/'); break; } catch { await sleep(200); } }
    const admin = api(await login('admin', 'testpassword1')), va = api(await login('va1', 'testpassword2'));
    for (let i = 0; i < 30 && !(await admin.get('/devices')).devices.every(d => d.ready); i++) await sleep(500);
    ok((await admin.get('/devices')).devices.every(d => d.ready), 'alle Handys bereit');

    // 1 Warteschlange: 10 gleichzeitige Tipps kommen einzeln nacheinander an
    const t0 = Date.now();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => admin.post('/cmd/1/tap', { x: 0.1 * i, y: 0.5 })));
    const s1 = await stats(1);
    ok(res.every(r => r.ok), '10 Tipps ok');
    ok(s1.maxParallel === 1, 'nie zwei Aufrufe gleichzeitig an WDA', s1.maxParallel);
    ok(Date.now() - t0 >= 1400, '10 x 150 ms nacheinander', Date.now() - t0);

    // 2 Auto-Scroll: Wische, die auf einen wartenden Befehl treffen, werden verworfen
    const auto = await Promise.all(Array.from({ length: 6 }, () => admin.post('/cmd/1/swipe', { auto: true, path: [{ x: 0.5, y: 0.8, t: 0 }, { x: 0.5, y: 0.2, t: 200 }] })));
    ok(auto.filter(r => r.skipped).length >= 4, 'Auto-Wische bei Stau verworfen', auto.map(r => r.skipped ? 's' : 'x').join(''));

    // 3 Warmup einrichten
    await admin.post('/warmup', { window: ['00:00', '23:59'] });
    for (const id of [2, 3, 4]) await admin.post('/warmup', { phone: id, start: today, niche: 'Gaming, Cosplay' });
    await sleep(31000);   // ein Takt des Planers
    const p2 = await phone(admin, 2);
    ok(p2.warmup.day === 1 && p2.warmup.today.scroll === 40, 'Tag 1 mit 40 min Scroll', { day: p2.warmup.day, today: p2.warmup.today });
    ok(p2.warmup.sessions.length >= 1, 'Sitzungen für heute geplant', p2.warmup.sessions);
    const va1 = (await (await va.get('/warmup')));
    ok(va1.window && va1.template.length === 14, 'Vorlage 14 Tage lesbar');
    ok((await va.post('/warmup', { phone: 2, paused: true })).status === 403, 'VA darf den Warmup nicht ändern');

    // 4 Claude-Sitzung starten, VA übernimmt
    ok((await admin.post('/warmup/2/run', { minutes: 2 })).ok, 'Sitzung auf Handy 2 gestartet');
    await sleep(9000);
    const run = await phone(admin, 2);
    ok(run.warmup.claude && run.lockedBy === 'claude', 'Handy 2 als Claude belegt', { claude: run.warmup.claude, lockedBy: run.lockedBy });
    ok((await stats(2)).app === 'com.burbn.instagram', 'Instagram geöffnet');
    const take = await va.post('/cmd/2/tap', { x: 0.5, y: 0.5 });
    ok(take.ok, 'VA kann übernehmen, kein 409', take);
    await sleep(1500);
    const after = await phone(admin, 2);
    ok(!after.warmup.claude && after.lockedBy === 'va1', 'Claude hat abgegeben, Handy gehört va1', { lockedBy: after.lockedBy });
    const log = fs.readFileSync(path.join(DATA, 'logs', 'scroll.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    ok(log.some(l => l.handy === 2 && l.ereignis === 'ende' && /took over/.test(l.grund)), 'Ende mit Grund "took over" im Log', log.slice(-1)[0]);
    ok((await admin.post('/cmd/2/tap', { x: 0.5, y: 0.5 })).status === 409, 'zweiter Mensch bekommt 409');

    // 5 Wächter: Handy 3 zeigt einen Sperrhinweis
    await admin.post('/warmup/3/run', { minutes: 2 });
    await sleep(10000);
    const p3 = await phone(admin, 3);
    ok(p3.warmup.alert && !p3.warmup.claude, 'Alarm auf Handy 3, Sitzung beendet', p3.warmup.alert);
    ok((await stats(3)).app === 'com.apple.springboard', 'Handy 3 zurück auf dem Homescreen');
    ok(fs.readFileSync(path.join(DATA, 'logs', 'alerts.log'), 'utf8').includes('Phone 3'), 'alerts.log geschrieben');
    await admin.post('/warmup/3/clear');
    ok(!(await phone(admin, 3)).warmup.alert, 'Alarm quittiert');

    // 6 VA-Zähler: 2 Likes, 1 Kommentar per Enter, 1 gesendeter Text
    await va.post('/cmd/4/doubletap', { x: 0.5, y: 0.5 }); await va.post('/cmd/4/doubletap', { x: 0.5, y: 0.5 });
    await va.post('/cmd/4/keys', { text: 'so cool\n' }); await va.post('/cmd/4/text', { text: 'nice' });
    await sleep(5500);
    const p4 = await phone(admin, 4);
    ok(p4.warmup.done.likes === 2 && p4.warmup.done.comments === 2, 'Likes 2, Kommentare 2 auf Handy 4', p4.warmup.done);

    // 7 Stream: Bilder kommen an, Insights rechnen
    const ctl = new AbortController(); let bytes = 0;
    const sr = await fetch(B + '/stream/1', { headers: { cookie: (await login('admin', 'testpassword1')) }, signal: ctl.signal });
    const rd = sr.body.getReader(); const until = Date.now() + 1500;
    while (Date.now() < until) { const { value, done } = await rd.read(); if (done) break; bytes += value.length; }
    ctl.abort();
    ok(bytes > 20000, 'Stream liefert Bilder', bytes);
    const ins = await admin.get('/insights');
    ok(ins.today.length > 0 && ins.devices.length === CFG.devices.length, 'Insights ok');
  } catch (e) { console.log('FAIL Ausnahme:', e.stack); failed++; }
  finally {
    if (failed) console.log('--- Server-Log ---\n' + server.out.slice(-3000));
    procs.forEach(p => p.kill());
    console.log(failed ? `${failed} Fehler` : 'alles ok');
    process.exit(failed ? 1 : 0);
  }
})();
