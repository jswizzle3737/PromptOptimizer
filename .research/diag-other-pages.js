/**
 * Reproduction: in-page modal on a NON-listed page (the "other pages" flow).
 *
 * 1. Launch Edge + extension (headless, fresh profile).
 * 2. Serve a mock chat page on http://127.0.0.1:8765.
 * 3. Grant the origin the way the popup's "Turn on" does (permissions.request
 *    with a CDP user gesture), then inject content.css + content.js the way
 *    ENABLE_SITE does.
 * 4. Open the in-page modal and dump the engine picker state, shared-module
 *    loading, and run one optimization to capture the degrade reason.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BROWSER_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.resolve(__dirname, '..');
const TEMP_USER_DATA = path.join(process.env.TEMP, `chrome-diag-${Date.now()}`);
const DEBUG_PORT = 9333;
const ORIGIN = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body><h1>Mock page</h1><textarea id="prompt-textarea"></textarea></body></html>');
  });
  await new Promise(r => server.listen(8765, '127.0.0.1', r));

  const browser = spawn(BROWSER_PATH, [
    `--user-data-dir=${TEMP_USER_DATA}`,
    `--load-extension=${EXT_PATH}`,
    '--remote-debugging-port=9333',
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { browser.kill('SIGKILL'); } catch {}
    server.close();
    setTimeout(() => { try { fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} }, 1500);
  };

  try {
    // CDP base
    let base;
    for (let i = 0; i < 40 && !base; i++) {
      for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
        try {
          const res = await fetch(`http://${host}:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(2500) });
          if (res.ok) { base = `http://${host}:${DEBUG_PORT}`; break; }
        } catch {}
      }
      if (!base) await sleep(400);
    }
    if (!base) throw new Error('no CDP endpoint');

    // find SW target (match OUR extension, not Edge's built-ins)
    let swWs;
    for (let i = 0; i < 30 && !swWs; i++) {
      const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2500) })).json();
      const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('background/service-worker.js'));
      if (sw) swWs = sw.webSocketDebuggerUrl;
      else await sleep(400);
    }
    if (!swWs) throw new Error('PromptOptimizer service worker target not found');

    const connect = async url => {
      const ws = new WebSocket(url);
      let msgId = 0;
      const pending = new Map();
      const events = [];
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method) events.push(m);
      };
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return {
        send: (method, params = {}, opts = {}) => new Promise(res => {
          const id = ++msgId;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }));
        }),
        events
      };
    };

    const sw = await connect(swWs);
    await sw.send('Runtime.enable');

    const swEval = async (expression, userGesture = true) => {
      const res = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
      if (res.result?.exceptionDetails) {
        return { __exception: res.result.exceptionDetails.exception?.description || JSON.stringify(res.result.exceptionDetails).slice(0, 300) };
      }
      return res.result?.result?.value;
    };

    // open the mock page
    const tabRes = await (await fetch(`${base}/json/new?${ORIGIN}/`, { method: 'PUT' })).json();
    console.log('page opened:', tabRes.url);
    await sleep(800);
    const page = await connect(tabRes.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    // Grant + inject, exactly the popup "Turn on" + ENABLE_SITE sequence.
    const grant = await swEval(`(async () => {
      const patterns = [
        ['${ORIGIN}/*'],
        ['http://127.0.0.1/*'],
        ['http://localhost:8765/*'],
        ['*://127.0.0.1:8765/*'],
        ['http://*/*', 'https://*/*']
      ];
      const attempts = [];
      for (const origins of patterns) {
        try {
          const ok = await chrome.permissions.request({ origins });
          attempts.push({ origins, ok });
          if (ok) return { granted: true, via: origins };
        } catch (e) { attempts.push({ origins, error: String(e && e.message || e) }); }
      }
      const all = await chrome.permissions.getAll();
      return { granted: false, attempts, all };
    })()`);
    console.log('permission grant:', JSON.stringify(grant, null, 2));
    if (!grant || grant.granted !== true) {
      throw new Error('could not grant origin permission in this environment: ' + JSON.stringify(grant));
    }

    const inject = await swEval(`(async () => {
      const tabs = await chrome.tabs.query({ url: '${ORIGIN}/*' });
      const tabId = tabs[0]?.id;
      if (tabId == null) return { error: 'tab not found' };
      try {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
        return { injected: true, tabId };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    console.log('inject:', JSON.stringify(inject));
    await sleep(1200);

    // Open the modal by clicking the pill (page world can reach the open shadow root)
    await page.send('Runtime.evaluate', { expression: `
      document.getElementById('prompt-textarea').focus();
    ` });
    await sleep(400);
    const openRes = await page.send('Runtime.evaluate', { expression: `
      (() => {
        const host = document.getElementById('promptcraft-root-host');
        if (!host || !host.shadowRoot) return { error: 'no host' };
        host.shadowRoot.querySelector('.pc-trigger-pill')?.click();
        return { clicked: true };
      })()
    `, returnByValue: true });
    console.log('open modal:', JSON.stringify(openRes.result?.result?.value));
    await sleep(600);

    // Dump engine picker + module state
    const dump = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const shadow = document.getElementById('promptcraft-root-host')?.shadowRoot;
      if (!shadow) return { error: 'no shadow' };
      const backdrop = shadow.querySelector('.pc-backdrop');
      const engineSlot = shadow.querySelector('#pc-engine-slot');
      const variantSlot = shadow.querySelector('#pc-variant-slot');
      const customSelect = engineSlot?.querySelector('.pc-select');
      const nativeSelect = engineSlot?.querySelector('select');
      const options = customSelect
        ? [...customSelect.querySelectorAll('.pc-select__option')].map(o => o.dataset.value)
        : nativeSelect ? [...nativeSelect.options].map(o => o.value) : [];
      const selected = customSelect?.dataset.value ?? nativeSelect?.value ?? null;
      const triggerLabel = customSelect?.querySelector('.pc-select__trigger')?.getAttribute('aria-label') || null;
      const themeMounted = Boolean(shadow.querySelector('#pc-theme-slot .pc-select'));
      const tabs = [...shadow.querySelectorAll('#pc-tabs .pc-segmented__item')].map(t => t.textContent.trim());
      // Console errors captured?
      return {
        modalOpen: backdrop?.classList.contains('is-open') ?? null,
        engineSelectKind: customSelect ? 'custom' : nativeSelect ? 'native' : 'none',
        optionCount: options.length,
        options,
        selected,
        triggerLabel,
        variantMounted: Boolean(variantSlot?.querySelector('.pc-select')),
        themeMounted,
        frameworkTabs: tabs,
        errors: window.__diagErrors || []
      };
    })()` });
    console.log('MODAL STATE:', JSON.stringify(dump.result?.result?.value, null, 2));

    // Collect any page errors so far
    const errs = page.events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    console.log('PAGE ERRORS:', JSON.stringify(errs.map(e => e.params).slice(0, 6), null, 2).slice(0, 2500));

    // Run one optimization from the modal (no keys configured) and capture the result payload
    const opt = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
      shadow.querySelector('#pc-raw-input').value = 'write a python script to parse csv files';
      shadow.querySelector('#pc-optimize-btn').click();
      await new Promise(r => setTimeout(r, 4000));
      const badge = shadow.querySelector('#pc-engine-badge');
      const notice = shadow.querySelector('#pc-degraded');
      return {
        badge: badge?.textContent,
        degradedShown: !notice?.hidden,
        degradedText: shadow.querySelector('#pc-degraded-title')?.textContent + ' :: ' + shadow.querySelector('#pc-degraded-reason')?.textContent
      };
    })()` });
    console.log('OPTIMIZE RESULT:', JSON.stringify(opt.result?.result?.value, null, 2));

    page.send('Page.close').catch(() => {});
  } finally {
    cleanup();
  }
}

main().catch(e => { console.error('DIAG FAILED:', e.message); process.exit(1); });
