#!/usr/bin/env node
// Ende-zu-Ende-Test ohne iPhone: startet test/fake-wda.js und den Server im Testbetrieb (PHONELAB_FAKE=1) mit eigenem
// Datenordner und prüft Warteschlange, Auto-Scroll, busy, Sperre, Tageszähler, Einzelbild, Stream und Insights.
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

const mkUser = (name, pw, admin) => { const salt = crypto.randomBytes(16); return { name, salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex'), admin, devices: 'all' }; };
fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify({ users: [mkUser('admin', 'testpassword1', true), mkUser('va1', 'testpassword2', false)] }));

const procs = {};
const start = (key, file, env) => { const p = spawn(process.execPath, [path.join(ROOT, file)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d); procs[key] = p; return p; };
start('fake', 'test/fake-wda.js', { FAKE_SLOW: '5' });
start('server', 'server.js', { PHONELAB_FAKE: '1', PHONELAB_DATA: DATA });

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
const swipe = { path: [{ x: 0.5, y: 0.8, t: 0 }, { x: 0.5, y: 0.2, t: 200 }] };

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/'); break; } catch { await sleep(200); } }
    const adminCookie = await login('admin', 'testpassword1');
    const admin = api(adminCookie), va = api(await login('va1', 'testpassword2'));
    for (let i = 0; i < 30 && !(await admin.get('/devices')).devices.every(d => d.ready); i++) await sleep(500);
    ok((await admin.get('/devices')).devices.every(d => d.ready), 'alle Handys bereit');

    // 1 Warteschlange: 10 gleichzeitige Tipps kommen einzeln nacheinander an
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

    // 3 Sperre: wer zuletzt bedient hat, hält das Handy 2 min
    ok((await va.post('/cmd/2/tap', { x: 0.5, y: 0.5 })).ok, 'VA bedient Handy 2');
    ok((await admin.post('/cmd/2/tap', { x: 0.5, y: 0.5 })).status === 409, 'zweiter Mensch bekommt 409');
    ok((await phone(admin, 2)).lockedBy === 'va1', 'Dashboard zeigt, wer Handy 2 hält');

    // 4 Tageszähler und Einzelbild
    await va.post('/cmd/4/doubletap', { x: 0.5, y: 0.5 }); await va.post('/cmd/4/doubletap', { x: 0.5, y: 0.5 });
    await va.post('/cmd/4/keys', { text: 'so cool\n' }); await va.post('/cmd/4/text', { text: 'nice' });
    await sleep(5500);
    const p4 = await phone(admin, 4);
    ok(p4.today.likes === 2 && p4.today.comments === 2, 'heute auf Handy 4: 2 Likes, 2 Kommentare', p4.today);
    const fr = await fetch(B + '/frame/1', { headers: { cookie: adminCookie } });
    ok(fr.status === 200 && fr.headers.get('content-type') === 'image/jpeg', '/frame liefert ein JPEG');

    // 4b Auto-Sperre: Handy 3 sperrt sich, das Dashboard sieht es, die nächste Eingabe weckt es zuerst
    await fetch(`http://127.0.0.1:${CFG.devices.find(d => d.id === 3).wda_port}/fake/lock`);
    let seen = false; for (let i = 0; i < 14 && !seen; i++) { await sleep(1000); seen = (await phone(admin, 3)).locked; }
    ok(seen, 'gesperrter Bildschirm wird erkannt');
    ok((await admin.post('/cmd/3/tap', { x: 0.5, y: 0.5 })).ok, 'Tipp auf gesperrtes Handy ok');
    const s3 = await stats(3);
    ok(!s3.locked && s3.unlocks === 1, 'Handy vor dem Tipp aufgeweckt', { locked: s3.locked, unlocks: s3.unlocks });

    // 5 Stream und Insights
    const ctl = new AbortController(); let bytes = 0;
    const sr = await fetch(B + '/stream/1', { headers: { cookie: adminCookie }, signal: ctl.signal });
    const rd = sr.body.getReader(); const until = Date.now() + 1500;
    while (Date.now() < until) { const { value, done } = await rd.read(); if (done) break; bytes += value.length; }
    ctl.abort();
    ok(bytes > 20000, 'Stream liefert Bilder', bytes);
    const ins = await admin.get('/insights');
    ok(ins.today.length > 0 && ins.devices.length === CFG.devices.length, 'Insights ok');
    const dev = await admin.get('/devices');
    ok(typeof dev.version === 'string', 'Version in /devices', dev.version);
  } catch (e) { console.log('FAIL Ausnahme:', e.stack); failed++; }
  finally {
    if (failed) console.log('--- Server ---\n' + procs.server.out.slice(-2000));
    Object.values(procs).forEach(p => p.kill());
    console.log(failed ? `${failed} Fehler` : 'alles ok');
    process.exit(failed ? 1 : 0);
  }
})();
