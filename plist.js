'use strict';
// Minimaler XML-Plist-Leser und -Schreiber, genau so viel wie usbmuxd braucht (dict, array, string, integer, bool).
// ponytail: kein data/date; usbmuxd-Antworten enthalten davon nichts.

function build(obj) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const val = v => {
    if (typeof v === 'string') return `<string>${esc(v)}</string>`;
    if (typeof v === 'number') return `<integer>${v}</integer>`;
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
    if (Array.isArray(v)) return `<array>${v.map(val).join('')}</array>`;
    return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${val(x)}`).join('')}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${val(obj)}</plist>\n`;
}

function parse(xml) {
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const toks = xml.match(/<[^>]+>|[^<]+/g).map(t => t.trim()).filter(t => t && !t.startsWith('<?') && !t.startsWith('<!'));
  let i = 0;
  const node = () => {
    const t = toks[i++];
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string>') { const v = toks[i] === '</string>' ? '' : unesc(toks[i++]); i++; return v; }
    if (t === '<string/>') return '';
    if (t === '<integer>' || t === '<real>') { const v = Number(toks[i++]); i++; return v; }
    if (t === '<data>' || t === '<date>') { const v = toks[i++]; i++; return v; }
    if (t === '<array>') { const a = []; while (toks[i] !== '</array>') a.push(node()); i++; return a; }
    if (t === '<array/>') return [];
    if (t === '<dict>') { const d = {}; while (toks[i] !== '</dict>') { i++; const k = unesc(toks[i++]); i++; d[k] = node(); } i++; return d; }
    if (t === '<dict/>') return {};
    if (t === '<plist version="1.0">' || t === '<plist>') { const v = node(); i++; return v; }
    throw new Error('plist: unerwartet ' + t);
  };
  return node();
}

module.exports = { build, parse };

if (require.main === module) { // Selbsttest
  const o = { a: 'x<y', n: 3, b: true, l: ['p', 2], d: { k: false } };
  const r = parse(build(o));
  console.assert(JSON.stringify(r) === JSON.stringify(o), 'Roundtrip fehlgeschlagen', r);
  console.log('plist ok');
}
