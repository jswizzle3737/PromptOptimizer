// Load the real extension in headless Chromium and import every web-accessible
// module from a content script (the isolated world the in-page panel and the
// Gmail tools run in). Exits 1 if any module or stylesheet fails to load.
//
//   node tools/check-extension-load.cjs [path/to/chrome.exe] [--from <unpacked dir>]
//
// --from checks another unpacked copy, e.g. the extracted release zip.
//
// Without a path it uses the newest Playwright Chromium under
// %LOCALAPPDATA%\ms-playwright. Branded Chrome ignores --load-extension.
// Works on a temporary copy of the extension (localhost access added), so the
// project files are never changed.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const root = fromAt >= 0 ? path.resolve(args.splice(fromAt, 2)[1]) : path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChromium() {
  if (args[0]) return args[0];
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('No Chromium found. Pass the path to chrome.exe (Chrome for Testing or Playwright Chromium).');
}

function copyExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-ext-'));
  for (const entry of ['manifest.json', 'background', 'content', 'shared', 'popup', 'options', 'offscreen', 'assets', 'icons']) {
    fs.cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
  }
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), 'http://127.0.0.1/*'];
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return { dir, resources: manifest.web_accessible_resources.flatMap(w => w.resources) };
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  return {
    ready: new Promise(r => { ws.onopen = r; }),
    close: () => ws.close(),
    evaluate: expression => new Promise(r => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    })
  };
}

(async () => {
  const chromium = findChromium();
  const { dir, resources } = copyExtension();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'po-profile-'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>check</title>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const browser = spawn(chromium, [
    '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`,
    `--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--no-first-run',
    `http://127.0.0.1:${server.address().port}/`
  ], { stdio: 'ignore' });

  let failed = true;
  try {
    let worker;
    for (let i = 0; i < 60 && !worker; i++) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        worker = list.find(t => t.type === 'service_worker' && t.url.includes('background/service-worker.js'));
      } catch { /* not listening yet */ }
    }
    if (!worker) throw new Error('The extension did not start (no service worker). Is the manifest valid?');
    const session = cdp(worker.webSocketDebuggerUrl);
    await session.ready;

    const files = resources.filter(f => /\.(js|css)$/.test(f));
    let report;
    for (let i = 0; i < 30; i++) {
      const r = await session.evaluate(`(async () => {
        if (!globalThis.chrome?.scripting) return 'wait';
        const [tab] = await chrome.tabs.query({});
        if (!tab || tab.status !== 'complete') return 'wait';
        const files = ${JSON.stringify(files)};
        const urls = files.map(f => chrome.runtime.getURL(f));
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'ISOLATED', args: [files, urls],
          func: async (files, urls) => {
            const out = {};
            for (let i = 0; i < files.length; i++) {
              try {
                if (files[i].endsWith('.css')) { const r = await fetch(urls[i]); out[files[i]] = r.ok ? 'ok' : 'HTTP ' + r.status; }
                else { await import(urls[i]); out[files[i]] = 'ok'; }
              } catch (e) { out[files[i]] = 'FAILED: ' + e.message; }
            }
            return out;
          }
        });
        return res.result;
      })()`);
      report = r.result?.result?.value ?? 'error: ' + (r.result?.exceptionDetails?.exception?.description || 'unknown');
      if (report !== 'wait') break;
      await sleep(400);
    }
    session.close();
    if (typeof report !== 'object') throw new Error(String(report));
    const bad = Object.entries(report).filter(([, v]) => v !== 'ok');
    console.log(`Chromium: ${path.basename(path.dirname(path.dirname(chromium)))}`);
    console.log(`Loaded from a content script: ${Object.keys(report).length - bad.length}/${Object.keys(report).length}`);
    for (const [f, v] of bad) console.log(`  ${f}: ${v}`);
    failed = bad.length > 0;
    if (!failed) console.log('All web-accessible modules and stylesheets load.');
  } catch (e) {
    console.log('ERROR ' + e.message);
  } finally {
    browser.kill();
    server.close();
    await sleep(500);
    for (const d of [dir, profile]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked; temp dir */ } }
    process.exitCode = failed ? 1 : 0;
  }
})();
