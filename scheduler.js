#!/usr/bin/env node
// Tagesplan für Scroll-Sitzungen: je Handy 2 bis 4 Sitzungen zu zufälligen Zeiten im Zeitfenster, nie im gleichen Takt.
// Liest scroll.json, startet scroll.js. Läuft dauerhaft: node scheduler.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scroll.json'), 'utf8'));
const rnd = (a, b) => a + Math.random() * (b - a);
const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// Plan für heute: Startzeiten in Minuten seit Mitternacht, Mindestabstand 90 min, je Handy eigener Zufall
function planDay() {
  const [w0, w1] = CFG.window.map(hm), plan = [];
  for (const id of CFG.devices) {
    const n = Math.round(rnd(CFG.sessions_per_day[0], CFG.sessions_per_day[1]));
    const starts = [];
    for (let tries = 0; starts.length < n && tries < 200; tries++) {
      const t = Math.round(rnd(w0, w1 - 20));
      if (starts.every(s => Math.abs(s - t) >= 90)) starts.push(t);
    }
    for (const t of starts) plan.push({ id, start: t, minutes: Math.round(rnd(CFG.minutes[0], CFG.minutes[1])) });
  }
  return plan.sort((a, b) => a.start - b.start);
}

function runSession(s) {
  const args = [path.join(ROOT, 'scroll.js'), String(s.id), String(s.minutes)];
  if (CFG.niche) args.push('--niche', CFG.niche);
  console.log(new Date().toISOString(), `Handy ${s.id}: Sitzung ${s.minutes} min`);
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  p.on('exit', code => { if (code === 2) { console.log(`Handy ${s.id}: Warnung, Handy für heute aus dem Plan genommen`); plan = plan.filter(x => x.id !== s.id); } });
}

let day = null, plan = [];
setInterval(() => {
  const now = new Date(), today = now.toDateString(), min = now.getHours() * 60 + now.getMinutes();
  if (day !== today) { day = today; plan = planDay(); console.log(today, 'Plan:', plan.map(s => `Handy ${s.id} ${String(Math.floor(s.start / 60)).padStart(2, '0')}:${String(s.start % 60).padStart(2, '0')} ${s.minutes}min`).join(', ')); }
  for (const s of plan) if (!s.done && s.start <= min) { s.done = true; runSession(s); }
}, 30000);
console.log('Planer läuft, Zeitfenster', CFG.window.join(' bis '), 'Handys', CFG.devices.join(', '));
