/**
 * Theme integrity check.
 *
 * Loads the popup, cycles every theme, and measures:
 *  1. Whether each token actually resolves (catches palette leaks).
 *  2. WCAG contrast on the pairs that carry the interface.
 *  3. Whether any rendered element paints text in the surface color.
 */

const { spawn } = require('child_process');
const path = require('path');

const BROWSER_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.resolve(__dirname);
const TEMP_USER_DATA = path.join(process.env.TEMP || 'C:\\Temp', `pc-theme-check-${Date.now()}`);

/* The designs on offer are whatever THEMES lists in theme-picker.js. */
const THEMES = [...require('fs')
  .readFileSync(path.join(EXT_PATH, 'shared', 'theme-picker.js'), 'utf8')
  .matchAll(/^\s*id:\s*'([a-z]+)'/gm)].map(m => m[1]);

/* Set SHOTS_DIR to also save a popup screenshot per design. */
const SHOTS_DIR = process.env.SHOTS_DIR || null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const myId = id++;
        pending.set(myId, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: myId, method, params }));
      }),
      close: () => ws.close()
    });
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      }
    };
    ws.onerror = reject;
  });
}

const AUDIT = `
(() => {
  const cs = getComputedStyle(document.documentElement);
  const tok = n => cs.getPropertyValue(n).trim();

  // --- contrast helpers ---
  const parse = c => {
    if (!c) return null;
    c = String(c).trim();
    let m = c.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
      if (h.length === 8) {
        return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16),
                 b: parseInt(h.slice(4,6),16), a: parseInt(h.slice(6,8),16) / 255 };
      }
      return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16),
               b: parseInt(h.slice(4,6),16), a: 1 };
    }
    m = c.match(/rgba?\\(([^)]+)\\)/i);
    if (m) {
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  };
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const flatten = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1
  });
  const ratio = (a, b) => {
    const A = parse(a), B = parse(b);
    if (!A || !B) return null;
    const f = flatten(A, B);
    const l1 = lum(f), l2 = lum(B);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  const pairs = {
    'primary/canvas':    [tok('--text-primary'), tok('--bg-canvas')],
    'primary/surface':   [tok('--text-primary'), tok('--bg-surface')],
    'secondary/surface': [tok('--text-secondary'), tok('--bg-surface')],
    'tertiary/surface':  [tok('--text-tertiary'), tok('--bg-surface')],
    'onAccent/accent':   [tok('--text-on-accent'), tok('--accent')],
    'accentFg/surface':  [tok('--accent-fg'), tok('--bg-surface')],
    'successFg/surface': [tok('--success-fg'), tok('--bg-surface')],
    'dangerFg/surface':  [tok('--danger-fg'), tok('--bg-surface')]
  };

  const contrast = {};
  for (const [k, [a, b]] of Object.entries(pairs)) contrast[k] = ratio(a, b);

  // --- unresolved token detection ---
  const required = ['--bg-canvas','--bg-surface','--bg-sunken','--border-default',
    '--text-primary','--text-secondary','--accent','--text-on-accent','--accent-fg',
    '--success','--danger','--ring','--shadow-2','--radius-md','--space-4','--text-base'];
  const missing = required.filter(t => !tok(t));

  // --- invisible text detection across every rendered element ---
  // Resolve the effective background by walking ancestors: a white label on an
  // indigo button is fine, even though it contrasts poorly with --bg-surface.
  const effectiveBg = el => {
    // Collect the translucent layers up to the first opaque ancestor, then
    // composite them bottom-up. A tinted callout over a card is the colour the
    // eye sees, not the tint on its own.
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const p = parse(getComputedStyle(node).backgroundColor);
      if (p && p.a > 0) {
        layers.push(p);
        if (p.a >= 0.99) break;
      }
      node = node.parentElement;
    }
    let base = layers.length && layers[layers.length - 1].a >= 0.99
      ? layers.pop()
      : parse(tok('--bg-canvas'));
    while (layers.length) base = flatten(layers.pop(), base);
    return 'rgb(' + Math.round(base.r) + ', ' + Math.round(base.g) + ', ' + Math.round(base.b) + ')';
  };

  void document.body.offsetHeight; // force style recalc before sampling

  let invisible = [];
  document.querySelectorAll('*').forEach(el => {
    const s = getComputedStyle(el);
    if (!el.textContent?.trim() || el.children.length) return;
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return;
    const r = ratio(s.color, effectiveBg(el));
    if (r !== null && r < 1.6) {
      invisible.push({
        sel: el.className || el.tagName,
        parent: el.parentElement?.className || el.parentElement?.tagName,
        text: el.textContent.trim().slice(0, 18),
        color: s.color, bg: effectiveBg(el), ratio: r
      });
    }
  });

  return { contrast, missing, invisible: invisible.slice(0, 5) };
})()
`;

async function main() {
  require('fs').mkdirSync(TEMP_USER_DATA, { recursive: true });

  const proc = spawn(BROWSER_PATH, [
    `--user-data-dir=${TEMP_USER_DATA}`,
    `--load-extension=${EXT_PATH}`,
    '--remote-debugging-port=9333',
    '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'
  ], { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch('http://127.0.0.1:9333/json/version')).ok) { ok = true; break; } }
    catch { await sleep(300); }
  }
  if (!ok) throw new Error('Browser did not start');

  try {
    let extId = null;
    for (let i = 0; i < 25 && !extId; i++) {
      const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('service-worker.js'));
      extId = sw?.url.match(/chrome-extension:\/\/([a-z0-9]+)/i)?.[1];
      if (!extId) await sleep(300);
    }
    if (!extId) throw new Error('Extension not loaded');

    const tab = await (await fetch('http://127.0.0.1:9333/json/new', { method: 'PUT' })).json();
    const client = await createCdpClient(tab.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` });
    await sleep(1500);

    console.log('Theme audit — WCAG contrast ratios (AA body text needs 4.5, UI/large needs 3.0)\n');
    const header = ['theme', 'primary/canvas', 'primary/surface', 'secondary/surface',
      'tertiary/surface', 'onAccent/accent', 'accentFg/surf', 'successFg', 'dangerFg', 'invisible'];
    console.log(header.map(h => h.padEnd(17)).join(''));
    console.log('-'.repeat(header.length * 17));

    let failures = 0;

    for (const theme of THEMES) {
      await client.send('Runtime.evaluate', {
        expression: `document.documentElement.setAttribute('data-theme', '${theme}')`
      });
      await sleep(500);
      const res = await client.send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
      const r = res.result.value;

      const c = r.contrast;
      const flags = [];
      if (c['primary/canvas'] < 4.5) flags.push('primary/canvas');
      if (c['secondary/surface'] < 4.5) flags.push('secondary/surface');
      if (c['tertiary/surface'] < 3.0) flags.push('tertiary/surface');
      if (c['onAccent/accent'] < 3.0) flags.push('onAccent/accent');
      if (r.missing.length) flags.push('MISSING:' + r.missing.join(','));
      if (r.invisible.length) flags.push('INVISIBLE x' + r.invisible.length);
      if (flags.length) failures++;

      console.log([
        theme,
        c['primary/canvas'], c['primary/surface'], c['secondary/surface'], c['tertiary/surface'],
        c['onAccent/accent'], c['accentFg/surface'], c['successFg/surface'], c['dangerFg/surface'],
        r.invisible.length
      ].map(v => String(v).padEnd(17)).join('') + (flags.length ? '  <-- ' + flags.join(', ') : ''));

      if (r.invisible.length) console.log('   ', JSON.stringify(r.invisible));
    }

    // Second pass: the working view, with a degraded result showing, because
    // that is where the callout and badge colours actually appear.
    await client.send('Runtime.evaluate', {
      expression: `
        document.getElementById('onboarding-start')?.click();
        const raw = document.getElementById('raw-prompt');
        raw.value = 'write a python script to parse csv files';
        raw.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('optimize-btn').click();
      `
    });
    await sleep(1500);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 640, deviceScaleFactor: 1, mobile: false });

    console.log('\nWorking view (degraded result showing):');
    for (const theme of THEMES) {
      await client.send('Runtime.evaluate', {
        expression: `document.documentElement.setAttribute('data-theme', '${theme}')`
      });
      await sleep(400);
      const res = await client.send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
      const r = res.result.value;
      const flags = [];
      if (r.missing.length) flags.push('MISSING:' + r.missing.join(','));
      if (r.invisible.length) flags.push('INVISIBLE x' + r.invisible.length);
      if (flags.length) failures++;
      console.log('  ' + theme.padEnd(12) + (flags.length ? '<-- ' + flags.join(', ') : 'ok'));
      if (r.invisible.length) console.log('   ', JSON.stringify(r.invisible));

      if (SHOTS_DIR) {
        require('fs').mkdirSync(SHOTS_DIR, { recursive: true });
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        require('fs').writeFileSync(path.join(SHOTS_DIR, `popup-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
    }

    console.log('\n' + (failures === 0
      ? `PASS: all ${THEMES.length} designs resolve every token and meet AA where required.`
      : `FAIL: ${failures} design(s) flagged.`));

    client.close();
  } finally {
    proc.kill('SIGTERM');
    await sleep(600);
    try { require('fs').rmSync(TEMP_USER_DATA, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error('Audit failed:', e); process.exit(1); });
