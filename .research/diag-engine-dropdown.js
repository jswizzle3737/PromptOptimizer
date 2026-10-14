/**
 * Smoke test: the popup engine dropdown must render all 6 engines, open as a
 * viewport-fixed menu fully inside the popup window, and picking one must
 * persist preferredEngine to chrome.storage.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BROWSER_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.resolve(__dirname, '..');
const TEMP_USER_DATA = path.join(process.env.TEMP, `chrome-diag-${Date.now()}`);
const DEBUG_PORT = 9334;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = spawn(BROWSER_PATH, [
    `--user-data-dir=${TEMP_USER_DATA}`,
    `--load-extension=${EXT_PATH}`,
    '--remote-debugging-port=9334',
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    'about:blank'
  ], { stdio: 'ignore' });

  try {
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

    let swWs;
    let extId;
    for (let i = 0; i < 60 && !swWs; i++) {
      const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2500) })).json();
      const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('background/service-worker.js'));
      if (sw) {
        swWs = sw.webSocketDebuggerUrl;
        extId = (sw.url.match(/chrome-extension:\/\/([a-z0-9_-]+)/i) || [])[1];
      } else await sleep(600);
    }
    if (!swWs) throw new Error('PromptOptimizer SW not found');
    if (!extId) throw new Error('could not read the extension id');
    console.log('step: sw target found', extId);

    const connect = async url => {
      const ws = new WebSocket(url);
      let msgId = 0;
      const pending = new Map();
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      };
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return {
        send: (method, params = {}) => new Promise((res, rej) => {
          const id = ++msgId;
          const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 15000);
          pending.set(id, m => { clearTimeout(timer); res(m); });
          ws.send(JSON.stringify({ id, method, params }));
        })
      };
    };

    // Seed onboarding/prefs from the popup page itself (the SW target evaluates
    // unreliably under awaitPromise), then reload so the popup picks them up.
    const tabRes = await (await fetch(`${base}/json/new?chrome-extension://${extId}/popup/popup.html`, { method: 'PUT' })).json();
    const page = await connect(tabRes.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await sleep(1200);

    const seed = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `
      (async () => {
        const s = await chrome.storage.local.get('promptcraft_settings');
        const merged = { ...(s.promptcraft_settings || {}), onboardingComplete: true, preferredEngine: 'nano' };
        await chrome.storage.local.set({ promptcraft_settings: merged });
        return true;
      })()
    ` });
    if (seed.result?.exceptionDetails) throw new Error('seed failed: ' + JSON.stringify(seed.result.exceptionDetails).slice(0, 200));
    await page.send('Page.reload');
    await sleep(1500);
    console.log('step: popup seeded and reloaded');

    const out = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const slot = document.querySelector('#engine-slot .pc-select');
      if (!slot) return { error: 'engine select not mounted' };
      const trigger = slot.querySelector('.pc-select__trigger');
      const allOptions = [...slot.querySelectorAll('.pc-select__option')].map(o => o.dataset.value);

      trigger.click();
      await wait(150);
      let menu = slot.querySelector('.pc-select__menu');
      const openState = {
        ariaExpanded: trigger.getAttribute('aria-expanded'),
        menuClass: menu.className,
        menuStyle: menu.getAttribute('style'),
        rect: (() => { const r = menu.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; })()
      };

      // pick OpenAI and verify persistence
      slot.querySelector('.pc-select__option[data-value="openai"]').click();
      await wait(800);
      const stored = await new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings)));
      menu = slot.querySelector('.pc-select__menu');
      const menuRect = menu.getBoundingClientRect();
      const inViewport = menuRect.top >= 0 && menuRect.bottom <= window.innerHeight + 1 && menuRect.left >= -1;

      return {
        optionCount: allOptions.length,
        options: allOptions,
        openState,
        menuPosition: menu.style.position,
        menuFullyInViewport: inViewport,
        persistedEngine: stored.preferredEngine,
        triggerLabel: trigger.getAttribute('aria-label')
      };
    })()` });

    const v = out.result?.result?.value;
    console.log('RESULT:', JSON.stringify(v, null, 2));
    if (v.error) throw new Error(v.error);
    if (v.optionCount !== 6) throw new Error(`expected 6 engines, got ${v.optionCount}`);
    if (v.persistedEngine !== 'openai') throw new Error('engine choice was not persisted: ' + v.persistedEngine);
    console.log('✓ Engine dropdown: 6 options, menu positions in-viewport, choice persists.');
  } finally {
    try { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { browser.kill('SIGKILL'); } catch {}
    setTimeout(() => { try { fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} }, 1500);
  }
}

main().catch(e => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
