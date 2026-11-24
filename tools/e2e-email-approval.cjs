// End-to-end, in headless Chromium with the real extension loaded:
// Email replies page -> worker -> approval notice -> "don't ask again".
// OmniRoute points at a local fake gateway that counts requests, so nothing
// leaves the machine. Uses trusted (CDP) mouse clicks, which the notice requires.
//
//   node tools/e2e-email-approval.cjs [path/to/chrome.exe]
//
// Exits 1 if a check fails. Works on a temporary copy of the extension.
const { spawn } = require('child_process');
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const project = path.resolve(__dirname, '..');
function findChromium() {
  if (process.argv[2]) return process.argv[2];
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) { const exe = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(exe)) return exe; }
  throw new Error('No Chromium found. Pass the path to chrome.exe.');
}
const chromium = findChromium();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

let requests = 0;
const gateway = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ choices: [{ message: { content: `Hi Sam, Friday works. (reply ${requests})` }, finish_reason: 'stop' }] }));
  });
});

function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) })); });
  return { ready: new Promise(r => ws.onopen = r), send, close: () => ws.close() };
}

(async () => {
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const gwPort = gateway.address().port;
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'po-e2e-ext-'));
  for (const e of ['manifest.json', 'background', 'content', 'shared', 'popup', 'options', 'offscreen', 'assets', 'icons']) fs.cpSync(path.join(project, e), path.join(ext, e), { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'))); mf.host_permissions.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'po-e2e-prof-'));
  const port = 9400 + Math.floor(Math.random() * 300);
  const browser = spawn(chromium, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let failures = 0;
  const check = (label, ok, detail = '') => { log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
  try {
    let version;
    for (let i = 0; i < 60 && !version; i++) { await sleep(500); try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {} }
    const b = cdp(version.webSocketDebuggerUrl); await b.ready;
    // Find the worker and configure OmniRoute -> fake gateway.
    let sw;
    for (let i = 0; i < 40 && !sw; i++) { await sleep(300); const { result } = await b.send('Target.getTargets'); sw = result.targetInfos.find(t => t.type === 'service_worker' && t.url.includes('background/service-worker.js')); }
    const extId = new URL(sw.url).host;
    const { result: swAttach } = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const evalIn = async (sid, expression) => { const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
    let ok;
    for (let i = 0; i < 20 && ok !== 'ok'; i++) {
      ok = await evalIn(swAttach.sessionId, `chrome.storage ? chrome.storage.local.set({ promptcraft_settings: { preferredEngine: 'omniroute', omnirouteEnabled: true, omnirouteBaseUrl: 'http://127.0.0.1:${gwPort}/v1', onboardingComplete: true } }).then(() => 'ok') : 'wait'`);
      if (ok !== 'ok') await sleep(300);
    }
    // Open the Email replies page.
    const { result: page } = await b.send('Target.createTarget', { url: `chrome-extension://${extId}/options/email-reply.html` });
    const { result: pAttach } = await b.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sid = pAttach.sessionId;
    await sleep(2000);
    const click = async selector => {
      const box = await evalIn(sid, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error('no element ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
    };
    const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { const v = await evalIn(sid, expr); if (v) return v; await sleep(200); } return null; };
    const noticeVisible = `(() => { const n = document.querySelector('.pc-secret-notice'); return n && !n.hidden; })()`;

    await evalIn(sid, `document.getElementById('incoming-email').value = 'Can we meet Friday at 3?'; true`);
    // 1. First draft: notice with the remember option.
    await click('#draft-reply');
    check('first draft asks for approval', Boolean(await waitFor(noticeVisible)));
    const remember = await evalIn(sid, `(() => { const r = document.querySelector('.pc-secret-notice__remember'); return r && !r.hidden ? r.textContent.trim() : null; })()`);
    check('remember option offered', Boolean(remember), remember || 'hidden');
    await evalIn(sid, `document.querySelector('[data-act="remember"]').click(); true`);
    await click('.pc-secret-notice [data-act="send"]');
    const first = await waitFor(`document.getElementById('reply-result').value.includes('reply 1') && document.getElementById('reply-result').value`);
    check('first draft arrives', Boolean(first), first || `requests=${requests}`);

    // 2. Second draft: no notice, request still sent.
    await click('#draft-reply');
    const second = await waitFor(`document.getElementById('reply-result').value.includes('reply 2') && document.getElementById('reply-result').value`);
    check('second draft skips the notice', Boolean(second) && !(await evalIn(sid, noticeVisible)), second || `requests=${requests}`);

    // 3. A credential in the email always asks, even when remembered.
    await evalIn(sid, `document.getElementById('incoming-email').value = 'Key: sk-proj-${'a'.repeat(30)}'; true`);
    await click('#draft-reply');
    const asked = await waitFor(noticeVisible);
    const rememberHidden = await evalIn(sid, `document.querySelector('.pc-secret-notice__remember').hidden`);
    check('credential warning still asks', Boolean(asked));
    check('no remember option on a credential warning', rememberHidden === true);
    await click('.pc-secret-notice [data-act="cancel"]');
    await sleep(500);
    check('cancel sends nothing', requests === 2, `requests=${requests}`);
    b.close();
  } catch (e) { log('ERROR', e.message); failures++; }
  finally {
    browser.kill(); gateway.close(); await sleep(500);
    for (const d of [ext, profile]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    log(failures ? `${failures} check(s) failed` : 'All checks passed');
    process.exitCode = failures ? 1 : 0;
  }
})();
