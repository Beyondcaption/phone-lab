#!/usr/bin/env node
// Selbsttest der Warmup-Verteilungen ohne Gerät: node scroll.js --dry
// Die Scroll-Sitzungen selbst laufen im Server (warmup.js), geplant über das Dashboard (Warmup), nicht mehr als eigener Prozess.
'use strict';
const { swipePath, dwell, dayIndex } = require('./warmup');

const assert = (ok, msg) => { if (!ok) { console.error('FEHLER:', msg); process.exit(1); } };
const d = Array.from({ length: 2000 }, () => dwell(false) / 1000).sort((a, b) => a - b);
const p = swipePath(-1), back = swipePath(+1);
assert(p.every(q => q.x >= 0.05 && q.x <= 0.95 && q.y >= 0.05 && q.y <= 0.95), 'Wischweg außerhalb');
assert(p[0].y - p[p.length - 1].y > 0.5, 'Wisch nach oben zu kurz');
assert(back[back.length - 1].y - back[0].y > 0.5, 'Wisch nach unten zu kurz');
assert(p.every((q, i) => i === 0 || q.t >= p[i - 1].t), 'Zeiten nicht aufsteigend');
assert(d[1000] > 4 && d[1000] < 9, 'Median Verweildauer unplausibel: ' + d[1000]);
assert(dayIndex('2026-10-29', '2026-10-29') === 1 && dayIndex('2026-10-29', '2026-11-11') === 14 && dayIndex('2026-10-30', '2026-10-29') === null, 'Warmup-Tag falsch');
console.log('Verweildauer s: min', d[0].toFixed(1), 'median', d[1000].toFixed(1), 'p90', d[1800].toFixed(1), 'max', d[1999].toFixed(1));
console.log('dry ok');
