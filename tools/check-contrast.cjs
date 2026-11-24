// WCAG AA contrast audit of every theme block in shared/theme.css.
// Translucent tokens are composited over the surface they sit on.
//   node tools/check-contrast.cjs [path/to/theme.css]
// Exits 1 when any pairing fails, so it can gate a release.
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'shared', 'theme.css'), 'utf8');
const blocks = [];
const re = /((?:\s*(?::root|\[data-theme="[\w-]+"\])\s*,?)+)\s*\{([^}]*)\}/g;
let m;
while ((m = re.exec(css))) {
  const ids = [...m[1].matchAll(/data-theme="([\w-]+)"|(:root)/g)].map(x => x[1] || 'root');
  const vars = Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(x => [x[1], x[2].trim()]));
  if (vars['--text-primary']) blocks.push({ id: ids.find(i => i !== 'root') || 'root', vars });
}
function parse(c) {
  c = c.trim();
  let x = c.match(/^#([0-9a-f]{3,8})$/i);
  if (x) {
    let h = x[1];
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  x = c.match(/^rgba?\(([^)]+)\)$/i);
  if (x) { const p = x[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return null;
}
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const fails = [];
for (const { id, vars } of blocks) {
  const v = k => parse(vars[k] || '');
  const bgs = ['--bg-canvas', '--bg-surface', '--bg-raised', '--bg-sunken'].filter(k => v(k));
  const surface = v('--bg-surface');
  const check = (label, fg, bg, min = 4.5) => {
    if (!fg || !bg) return;
    const r = ratio(fg[3] < 1 ? over(fg, bg) : fg, bg);
    if (r < min) fails.push(`${id.padEnd(12)} ${label.padEnd(44)} ${r.toFixed(2)} (< ${min})`);
  };
  for (const t of ['--text-primary', '--text-secondary', '--text-tertiary', '--accent-fg']) for (const b of bgs) check(`${t} on ${b}`, v(t), v(b));
  const withSoft = (soft, base) => v(soft) && base ? over(v(soft), base) : null;
  check('--accent-fg on accent-soft', v('--accent-fg'), withSoft('--accent-soft', surface));
  check('--text-on-accent on --accent', v('--text-on-accent'), v('--accent'));
  check('--text-on-accent on --accent-hover', v('--text-on-accent'), v('--accent-hover'));
  for (const s of ['danger', 'success', 'warning']) {
    check(`--${s}-fg on surface`, v(`--${s}-fg`), surface);
    check(`--${s}-fg on ${s}-soft`, v(`--${s}-fg`), withSoft(`--${s}-soft`, surface));
  }
  check('--border-focus on surface (UI)', v('--border-focus'), surface, 3);
  check('--text-primary on hover', v('--text-primary'), withSoft('--bg-hover', v('--bg-raised') || surface));
}
console.log(blocks.length + ' theme blocks: ' + blocks.map(b => b.id).join(', '));
console.log(fails.length ? fails.join('\n') : 'All pairs pass.');
if (fails.length) process.exitCode = 1;
