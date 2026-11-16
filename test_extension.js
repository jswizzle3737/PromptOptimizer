/**
 * Automated End-to-End Verification Script for PromptOptimizer Extension
 * Uses Chrome DevTools Protocol (CDP) and native Node 24 WebSocket to test:
 * 1. Extension Manifest & Loading in Chrome
 * 2. Background Service Worker initialization & status
 * 3. Popup UI rendering, framework tabs, and end-to-end prompt optimization
 * 4. Options UI rendering & settings persistence
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findBrowserExecutable() {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
    return process.env.BROWSER_PATH;
  }
  const candidatesByPlatform = {
    linux: [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/google-chrome'
    ],
    darwin: [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ]
  };
  for (const p of candidatesByPlatform[process.platform] || []) {
    if (fs.existsSync(p)) return p;
  }
  if (process.platform !== 'win32') {
    for (const cmd of ['chromium', 'chromium-browser', 'google-chrome']) {
      try {
        const resolved = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
        if (resolved && fs.existsSync(resolved)) return resolved;
      } catch {}
    }
  }
  throw new Error(`No supported browser binary found for "${process.platform}". Set BROWSER_PATH.`);
}

const BROWSER_PATH = findBrowserExecutable();
const EXT_PATH = path.resolve(__dirname);
/* Design count comes from the THEMES list, so adding a design never breaks this test. */
const DESIGN_COUNT = (fs.readFileSync(path.join(__dirname, 'shared/theme-picker.js'), 'utf8').match(/^    id: '/gm) || []).length;
/* Opens the engine picker under `rootExpr` and counts options that are fully
   visible: inside the menu's own clip and inside the viewport. A menu that
   squeezes into a short side shows three options and hides the rest. */
const engineMenuVisibility = (rootExpr, slotSel) => `(async () => {
  const root = ${rootExpr};
  const slot = root.querySelector('${slotSel} .pc-select');
  if (!slot) return { error: 'engine select not mounted' };
  const trigger = slot.querySelector('.pc-select__trigger');
  trigger.scrollIntoView({ block: 'nearest' });
  trigger.click();
  await new Promise(r => setTimeout(r, 350));
  const menu = slot.querySelector('.pc-select__menu');
  const m = menu.getBoundingClientRect();
  const opts = [...slot.querySelectorAll('.pc-select__option')];
  const visible = opts.filter(o => {
    const r = o.getBoundingClientRect();
    return r.top >= m.top - 1 && r.bottom <= m.bottom + 1 && r.top >= -1 && r.bottom <= innerHeight + 1;
  }).map(o => o.dataset.value);
  trigger.click();
  await new Promise(r => setTimeout(r, 200));
  return { total: opts.length, visible };
})()`;
const TEMP_USER_DATA = path.join(os.tmpdir(), `chrome-test-profile-${Date.now()}`);

const DEBUG_PORT = 9222;

/* Chromium's DevTools endpoint does not reliably bind IPv4 on Windows — it
   often lands on [::1] only, which makes a hardcoded 127.0.0.1 fetch fail
   intermittently and look like "the browser failed to launch". Probe every
   loopback form and latch onto whichever answers, then route all later CDP
   HTTP calls through it.

   Every request carries a timeout. Without one, a socket that connects but never
   responds hangs the whole suite indefinitely — the endpoint is reachable
   enough to accept the connection, so no error is raised and the surrounding
   retry loop never gets a turn. */
let cdpBase = null;
const CDP_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];
const CDP_TIMEOUT_MS = 8000;

async function cdpFetch(pathname, options = {}) {
  if (cdpBase) {
    const res = await fetch(cdpBase + pathname, { ...options, signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
    return res;
  }

  let lastErr;
  for (const host of CDP_HOSTS) {
    try {
      const res = await fetch(`http://${host}:${DEBUG_PORT}${pathname}`, {
        ...options,
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS)
      });
      cdpBase = `http://${host}:${DEBUG_PORT}`;
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`CDP unreachable on port ${DEBUG_PORT}`);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple CDP helper over native WebSocket
function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let idCounter = 1;
    const pending = new Map();
    const eventListeners = [];

    ws.onopen = () => {
      resolve({
        send: (method, params = {}) => {
          return new Promise((res, rej) => {
            const id = idCounter++;
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        onEvent: (fn) => eventListeners.push(fn),
        close: () => ws.close()
      });
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method) {
        eventListeners.forEach(fn => fn(msg));
      }
    };

    ws.onerror = (err) => reject(err);
  });
}

/**
 * Copy the shipped extension into a temp directory and add the mock chat/AI host to
 * the manifest permissions. The shipped manifest only lists real AI sites and cloud
 * APIs, and the mock server runs on 127.0.0.1. Nothing else differs from what ships.
 */
function prepareTestExtension() {
  const dest = `${TEMP_USER_DATA}-ext`;
  fs.mkdirSync(dest, { recursive: true });
  // The same list the store package ships (ship-files.json).
  const { files } = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'ship-files.json'), 'utf8'));
  for (const entry of files) {
    fs.cpSync(path.join(EXT_PATH, entry), path.join(dest, entry), { recursive: true });
  }
  const manifestPath = path.join(dest, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  manifest.host_permissions = [...(manifest.host_permissions || []), 'http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dest;
}

async function runTests() {
  console.log('=== Starting PromptOptimizer Automated Verification ===');
  console.log(`Extension Directory: ${EXT_PATH}`);
  console.log(`Chromium Executable: ${BROWSER_PATH}`);
  console.log(`Temp Profile: ${TEMP_USER_DATA}`);

  fs.mkdirSync(TEMP_USER_DATA, { recursive: true });
  const extUnderTest = prepareTestExtension();

  const browserArgs = [
    `--user-data-dir=${TEMP_USER_DATA}`,
    `--load-extension=${extUnderTest}`,
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    'about:blank'
  ];

  console.log('\n[1/5] Launching Chromium in test mode...');
  const browserProcess = spawn(BROWSER_PATH, browserArgs, {
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  });

  // Wait for CDP port to open
  let connected = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await cdpFetch('/json/version');
      if (res.ok) {
        connected = true;
        const ver = await res.json();
        console.log(`✓ Connected to Chromium CDP: ${ver['Browser']} (via ${cdpBase})`);
        break;
      }
    } catch {
      // Port not up yet.
    }
    await sleep(300);
  }

  if (!connected) {
    throw new Error(`Failed to connect to Chromium DevTools port ${DEBUG_PORT}`);
  }

  try {
    // 2. Discover Targets
    console.log('\n[2/5] Detecting loaded extension targets...');
    let extensionId = null;
    let swTarget = null;

    for (let retry = 0; retry < 20; retry++) {
      const targetsRes = await cdpFetch('/json/list');
      const targets = await targetsRes.json();
      
      for (const t of targets) {
        if (t.type === 'service_worker' && t.url.includes('background/service-worker.js')) {
          swTarget = t;
          const match = t.url.match(/chrome-extension:\/\/([a-z0-9_-]+)/i);
          if (match) {
            extensionId = match[1];
            break;
          }
        }
      }

      if (extensionId) break;
      await sleep(400);
    }

    if (!extensionId) {
      throw new Error('Could not find PromptOptimizer service worker target.');
    }

    console.log(`✓ Service Worker Active!`);
    console.log(`✓ Extension ID: ${extensionId}`);

    let swClient = null;
    if (swTarget?.webSocketDebuggerUrl) {
      swClient = await createCdpClient(swTarget.webSocketDebuggerUrl);
      await swClient.send('Runtime.enable');
      await swClient.send('Console.enable');
      swClient.onEvent((evt) => {
        if (evt.method === 'Runtime.consoleAPICalled') {
          console.log('  [ServiceWorker Console]:', evt.params.type, evt.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' '));
        } else if (evt.method === 'Runtime.exceptionThrown') {
          console.error('✗ ServiceWorker Exception:', evt.params.exceptionDetails);
        }
      });
    }

    // Test Service Worker direct communication or navigate to popup
    console.log('\n[3/5] Testing Popup UI & Optimization Flow...');
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const popupTabRes = await cdpFetch('/json/new', { method: 'PUT' });
    const popupTab = await popupTabRes.json();

    const popupClient = await createCdpClient(popupTab.webSocketDebuggerUrl);
    const popupLoadErrors = [];
    popupClient.onEvent((evt) => {
      if (evt.method === 'Runtime.exceptionThrown') {
        console.error('✗ Popup Exception:', evt.params.exceptionDetails);
        popupLoadErrors.push(`Exception: ${evt.params.exceptionDetails?.text || JSON.stringify(evt.params.exceptionDetails)}`);
      } else if (evt.method === 'Log.entryAdded' && (evt.params.entry?.level === 'error' || evt.params.entry?.level === 'warning')) {
        popupLoadErrors.push(`Log[${evt.params.entry.level}]: ${evt.params.entry.text}`);
      } else if (evt.method === 'Console.messageAdded') {
        console.log('  [Popup Console]:', evt.params.message.text);
        if (evt.params.message?.level === 'error' || evt.params.message?.level === 'warning') {
          popupLoadErrors.push(`Console[${evt.params.message.level}]: ${evt.params.message.text}`);
        }
      }
    });
    await popupClient.send('Runtime.enable');
    await popupClient.send('Page.enable');
    await popupClient.send('Console.enable');
    await popupClient.send('Log.enable');

    console.log(`Navigating tab to: ${popupUrl}`);
    await popupClient.send('Page.navigate', { url: popupUrl });

    // Wait until document is ready
    for (let r = 0; r < 20; r++) {
      const state = await popupClient.send('Runtime.evaluate', {
        expression: 'window.location.href + " | " + document.readyState'
      });
      console.log('Tab state:', state.result.value);
      if (state.result.value.includes('popup.html') && state.result.value.includes('complete')) break;
      await sleep(250);
    }
    await sleep(400);
    if (popupLoadErrors.length > 0) {
      throw new Error(`Popup emitted console/runtime errors on load: ${JSON.stringify(popupLoadErrors)}`);
    }

    // Evaluate DOM elements in Popup
    const titleCheck = await popupClient.send('Runtime.evaluate', {
      expression: 'document.querySelector(".pc-brand__name")?.textContent'
    });
    console.log(`✓ Popup Header Title: "${titleCheck.result.value}"`);
    // Top of the page: the logo and the yourlegalaid wordmark, at the same size.
    const lockupPopup = await popupClient.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const box = document.querySelector('.pc-lockup');
        const logo = document.querySelector('.pc-lockup__logo');
        const word = document.querySelector('.pc-lockup__word');
        if (!box || !logo || !word) return { error: 'lockup missing' };
        const lr = logo.getBoundingClientRect();
        const wr = word.getBoundingClientRect();
        const ws = getComputedStyle(word);
        return {
          first: document.body.firstElementChild === box || box.getBoundingClientRect().top <= 1,
          loaded: logo.complete && logo.naturalWidth > 0,
          transparent: true,
          logoHeight: Math.round(lr.height),
          wordFontSize: parseFloat(ws.fontSize),
          wordLineHeight: parseFloat(ws.lineHeight),
          wordText: word.textContent.trim(),
          appName: document.querySelector('.pc-brand__name')?.textContent.trim(),
          docTitle: document.title
        };
      })()`
    });
    const lkPopup = lockupPopup.result.value;
    console.log('✓ Popup lockup:', lkPopup);
    if (lkPopup.error) throw new Error('Popup: ' + lkPopup.error);
    if (!lkPopup.first) throw new Error('Popup: the lockup must be at the very top of the page');
    if (!lkPopup.loaded) throw new Error('Popup: the logo image did not load');
    if (lkPopup.wordText !== 'yourlegalaid') throw new Error('Popup: wordmark text is "' + lkPopup.wordText + '"');
    if (lkPopup.logoHeight !== lkPopup.wordFontSize || lkPopup.wordFontSize !== lkPopup.wordLineHeight) {
      throw new Error('Popup: logo and wordmark differ in size: ' + JSON.stringify(lkPopup));
    }
    if (lkPopup.appName !== 'PromptOptimizer') throw new Error('Popup: app name is "' + lkPopup.appName + '"');


    // Design-system assets must be linked and applied
    const tokenCheck = await popupClient.send('Runtime.evaluate', {
      expression: `(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          accent: cs.getPropertyValue('--accent').trim(),
          surface: cs.getPropertyValue('--bg-surface').trim(),
          sheets: document.styleSheets.length
        };
      })()`,
      returnByValue: true
    });
    console.log('✓ Design tokens resolved:', tokenCheck.result.value);
    if (!tokenCheck.result.value.accent) {
      throw new Error('Design tokens did not load — shared/theme.css is missing from the popup.');
    }

    // First-run onboarding: a fresh profile must land on the guide, not the tool.
    const onboardingCheck = await popupClient.send('Runtime.evaluate', {
      expression: `(() => {
        const guide = document.getElementById('onboarding-view');
        const main = document.getElementById('main-view');
        return {
          guideVisible: Boolean(guide) && !guide.hidden,
          mainHidden: Boolean(main) && main.hidden
        };
      })()`,
      returnByValue: true
    });
    console.log('✓ First-run onboarding shown:', onboardingCheck.result.value);
    if (!onboardingCheck.result.value.guideVisible) {
      throw new Error('First-run onboarding was not shown on a fresh profile.');
    }
    if (!onboardingCheck.result.value.mainHidden) {
      throw new Error('Onboarding is visible but the main view was not hidden.');
    }

    // Dismiss it so the rest of the suite exercises the working surface.
    await popupClient.send('Runtime.evaluate', {
      expression: 'document.getElementById("onboarding-start")?.click()'
    });
    await sleep(300);
    const dismissedCheck = await popupClient.send('Runtime.evaluate', {
      expression: 'document.getElementById("main-view")?.hidden === false'
    });
    console.log('✓ Onboarding dismissed, main view visible:', dismissedCheck.result.value);
    if (dismissedCheck.result.value !== true) {
      throw new Error('Onboarding did not dismiss to the main view.');
    }

    // Verify Default Selected Engine is Chrome Nano (custom listbox)
    // The popup builds its controls asynchronously, after settings resolve. Poll
    // for the listbox instead of assuming it exists the moment readyState is
    // "complete" — reading once here is a race that passes or fails on timing.
    let defaultEngine = null;
    for (let r = 0; r < 40; r++) {
      const probe = await popupClient.send('Runtime.evaluate', {
        expression: 'document.getElementById("engine-slot")?.querySelector(".pc-select")?.dataset.value'
      });
      defaultEngine = probe.result.value;
      if (defaultEngine) break;
      await sleep(150);
    }
    console.log(`✓ Default Selected Engine in Popup: "${defaultEngine}"`);
    if (defaultEngine !== 'nano') {
      throw new Error(`Expected default engine to be "nano", got "${defaultEngine}"`);
    }

    // A fresh install must hold no credential of any kind.
    const orKeyCheck = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `
        new Promise(resolve => {
          chrome.storage.local.get('promptcraft_settings', res => {
            const settings = res.promptcraft_settings || {};
            resolve({
              anyKey: ['openrouter', 'gemini', 'openai', 'anthropic', 'omniroute']
                .some(p => Boolean(settings[p + 'ApiKey'])),
              engine: settings.preferredEngine,
              schemaVersion: settings.schemaVersion,
              fallback1Engine: settings.fallback1Engine,
              fallback2Engine: settings.fallback2Engine,
              allowCloudFallback: settings.allowCloudFallback,
              omnirouteEnabled: settings.omnirouteEnabled
            });
          });
        })
      `,
      returnByValue: true
    });
    console.log('✓ Fresh-install settings verified in chrome.storage:', orKeyCheck.result.value);
    if (orKeyCheck.result.value.anyKey) {
      throw new Error('A fresh install must not ship with any API key.');
    }
    if (
      orKeyCheck.result.value.engine !== 'nano' ||
      orKeyCheck.result.value.schemaVersion !== 5 ||
      orKeyCheck.result.value.fallback1Engine !== '' ||
      orKeyCheck.result.value.fallback2Engine !== '' ||
      orKeyCheck.result.value.allowCloudFallback !== true ||
      orKeyCheck.result.value.omnirouteEnabled !== false
    ) {
      throw new Error(`Unexpected fresh-install settings: ${JSON.stringify(orKeyCheck.result.value)}`);
    }

    // Optimize with the default engine. Chrome Nano may or may not exist in this
    // browser; either outcome is valid, but a fallback must be labelled as one.
    console.log('→ Testing optimization with the default Chrome Nano engine...');
    console.log('  Typing test prompt: "write a python script to parse csv files"');
    await popupClient.send('Runtime.evaluate', {
      expression: `
        document.getElementById('raw-prompt').value = 'write a python script to parse csv files';
        document.getElementById('raw-prompt').dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('optimize-btn').click();
      `
    });

    // Wait for result to appear
    let optimizedText = '';
    let resultBadge = '';
    let degradedShown = false;
    for (let wait = 0; wait < 30; wait++) {
      await sleep(500);
      const res = await popupClient.send('Runtime.evaluate', {
        expression: `({
          text: document.getElementById("result-text")?.textContent || '',
          badge: document.getElementById("engine-status-badge")?.textContent || '',
          status: document.getElementById("status-message")?.textContent || '',
          degradedShown: !document.getElementById("degraded-notice")?.hidden
        })`,
        returnByValue: true
      });
      if (res.result.value?.text && res.result.value.text.length > 50) {
        optimizedText = res.result.value.text;
        resultBadge = res.result.value.badge;
        degradedShown = res.result.value.degradedShown;
        break;
      }
    }

    if (!optimizedText) {
      throw new Error('Popup optimization test timed out without result text');
    }

    // Principle: a degraded result is never presented as a success.
    if (resultBadge === 'Offline' && !degradedShown) {
      throw new Error('Nano fell back to the offline template without showing the degraded notice.');
    }
    console.log(`✓ Degraded notice consistent with engine badge (badge=${resultBadge}, notice=${degradedShown})`);

    console.log(`✓ Successfully received optimized prompt from PromptOptimizer [Badge: ${resultBadge}]:`);
    console.log('---------------------------------------------------------');
    console.log(optimizedText.split('\n').slice(0, 10).join('\n') + '\n...');
    console.log('---------------------------------------------------------');

    // The output box must show the whole result and run all the way down: no
    // fixed cap, no inner scrollbar, never underneath the status bar.
    console.log('→ Checking the output box runs all the way down in the popup...');
    await popupClient.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 600, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const measure = `(() => {
      const box = document.querySelector('.pc-output__box');
      const bar = document.querySelector('.pc-statusbar');
      const main = document.getElementById('main-view');
      const text = document.getElementById('result-text');
      main.scrollTop = main.scrollHeight;            // read the end of the page
      const b = box.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      const t = text.getBoundingClientRect();
      return {
        boxHeight: Math.round(b.height),
        textHeight: Math.round(t.height),
        gapToStatusBar: Math.round(r.top - b.bottom),
        boxScrollsInside: box.scrollHeight > box.clientHeight + 1,
        statusBarInView: r.top >= 0 && r.bottom <= innerHeight + 1
      };
    })()`;
    const shortLayout = (await popupClient.send('Runtime.evaluate', { expression: measure, returnByValue: true })).result.value;
    console.log('  short result :', shortLayout);

    await popupClient.send('Runtime.evaluate', {
      expression: `document.getElementById('result-text').textContent = Array.from({ length: 80 }, (_, i) => 'Line ' + (i + 1) + ' of a long optimized prompt that keeps going.').join('\\n')`
    });
    await sleep(200);
    const longLayout = (await popupClient.send('Runtime.evaluate', { expression: measure, returnByValue: true })).result.value;
    console.log('  long result  :', longLayout);

    for (const [name, m] of [['short', shortLayout], ['long', longLayout]]) {
      if (m.gapToStatusBar < 0) throw new Error('Output box runs under the status bar (' + name + '): ' + JSON.stringify(m));
      if (m.boxScrollsInside) throw new Error('Output box has an inner scrollbar instead of showing the result (' + name + '): ' + JSON.stringify(m));
      if (!m.statusBarInView) throw new Error('Status bar (Save / Copy) is out of reach (' + name + '): ' + JSON.stringify(m));
    }
    if (shortLayout.boxHeight < 132) throw new Error('Output box fell below its minimum height: ' + JSON.stringify(shortLayout));
    if (longLayout.boxHeight < longLayout.textHeight) {
      throw new Error('The box is shorter than the text it holds: ' + JSON.stringify(longLayout));
    }
    if (longLayout.boxHeight <= 210) throw new Error('Output box is still capped at its old 210px: ' + JSON.stringify(longLayout));
    console.log('✓ The popup output box shows the whole result, runs all the way down, and Save / Copy stay in reach');

    console.log('→ Checking every engine is visible in the popup engine picker...');
    for (const height of [600]) {   // the popup body is a fixed 600px, Chrome's popup cap
      await popupClient.send('Emulation.setDeviceMetricsOverride', { width: 440, height, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      const v = (await popupClient.send('Runtime.evaluate', { expression: engineMenuVisibility('document', '#engine-slot'), awaitPromise: true, returnByValue: true })).result.value;
      if (v.error || v.visible.length !== v.total || v.total !== 7 || !v.visible.includes('omniroute')) {
        throw new Error(`Popup engine picker at ${height}px hides engines or missing omniroute: ${JSON.stringify(v)}`);
      }
    }
    console.log('✓ Popup engine picker shows all 7 engines including omniroute');
    await popupClient.send('Emulation.clearDeviceMetricsOverride');

    // Test Framework switching in Popup (Switch to RTF without auto-running, then roving arrows, then Optimize)
    console.log('\n[4/5] Testing Framework switching (no auto-run + roving keyboard + RTF)...');
    const tabSwitchRes = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const tabsEl = document.getElementById('framework-tabs');
        const rtf = tabsEl.querySelector('.pc-segmented__item[data-framework="rtf"]');
        const smart = tabsEl.querySelector('.pc-segmented__item[data-framework="smart-expand"]');
        const beforeText = document.getElementById('result-text').textContent;
        rtf.click();
        await new Promise(r => setTimeout(r, 250));
        const afterClick = {
          rtfSelected: rtf.getAttribute('aria-selected'),
          rtfTabindex: rtf.getAttribute('tabindex'),
          smartSelected: smart.getAttribute('aria-selected'),
          smartTabindex: smart.getAttribute('tabindex'),
          status: document.getElementById('status-message').textContent,
          unchangedResult: document.getElementById('result-text').textContent === beforeText
        };
        rtf.focus();
        tabsEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        const afterRight = {
          focusedFramework: document.activeElement?.dataset?.framework || '',
          tabindex: document.activeElement?.getAttribute?.('tabindex') || ''
        };
        tabsEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        await new Promise(r => setTimeout(r, 50));
        const afterLeft = {
          focusedFramework: document.activeElement?.dataset?.framework || '',
          tabindex: document.activeElement?.getAttribute?.('tabindex') || ''
        };
        document.getElementById('optimize-btn').click();
        return { afterClick, afterRight, afterLeft };
      })()`
    });
    const tsPopup = tabSwitchRes.result.value;
    if (
      tsPopup.afterClick.rtfSelected !== 'true' ||
      tsPopup.afterClick.rtfTabindex !== '0' ||
      tsPopup.afterClick.smartSelected !== 'false' ||
      tsPopup.afterClick.smartTabindex !== '-1' ||
      !/Switched to RTF/.test(tsPopup.afterClick.status) ||
      !tsPopup.afterClick.unchangedResult
    ) {
      throw new Error(`Popup tab switch behavior incorrect: ${JSON.stringify(tsPopup)}`);
    }
    if (tsPopup.afterRight.focusedFramework === 'rtf' || tsPopup.afterRight.tabindex !== '0' || tsPopup.afterLeft.focusedFramework !== 'rtf') {
      throw new Error(`Popup roving tabindex arrow navigation failed: ${JSON.stringify(tsPopup)}`);
    }
    console.log('✓ Popup framework tab switch updates selection/roving tabindex and hints without auto-running');

    for (let wait = 0; wait < 40; wait++) {
      await sleep(250);
      const st = await popupClient.send('Runtime.evaluate', {
        expression: 'document.getElementById("status-message")?.textContent'
      });
      if (st.result.value && !/Optimizing/.test(st.result.value)) break;
    }

    const rtfResult = await popupClient.send('Runtime.evaluate', {
      expression: 'document.getElementById("result-text")?.textContent'
    });
    const rtfText = rtfResult.result.value || '';
    if (rtfText.includes('### ROLE') && rtfText.includes('### TASK') && rtfText.includes('### FORMAT')) {
      console.log('✓ RTF Framework correctly formatted output with ROLE, TASK, and FORMAT sections');
    } else {
      console.warn('⚠️ RTF text did not contain standard headings:', rtfText);
    }

    // Inline output editing + Undo in Popup
    console.log('→ Testing Popup inline output editing and Undo...');
    const editUndoRes = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const resEl = document.getElementById('result-text');
        const orig = resEl.textContent;
        const customFormExists = Boolean(document.querySelector('.pc-assist__custom .pc-assist__custom-input'));
        const contentEditableAttr = resEl.getAttribute('contenteditable');
        resEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'x' }));
        resEl.textContent = 'Short manual edit without sections';
        resEl.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 150));
        const editedStatus = document.getElementById('status-message').textContent;
        const editedQuality = document.getElementById('quality-chip').textContent;
        const undoBtn = document.querySelector('[data-act="undo"]');
        const undoVisible = Boolean(undoBtn) && !undoBtn.hidden;
        undoBtn?.click();
        await new Promise(r => setTimeout(r, 150));
        return {
          customFormExists,
          contentEditableAttr,
          editedStatus,
          editedQuality,
          undoVisible,
          revertedMatchesOriginal: resEl.textContent === orig,
          revertedStatus: document.getElementById('status-message').textContent
        };
      })()`
    });
    const eu = editUndoRes.result.value;
    if (
      !eu.customFormExists ||
      eu.contentEditableAttr !== 'plaintext-only' ||
      eu.editedStatus !== 'Edited' ||
      !eu.undoVisible ||
      !eu.revertedMatchesOriginal ||
      eu.revertedStatus !== 'Reverted change'
    ) {
      throw new Error(`Popup inline edit / Undo failed: ${JSON.stringify(eu)}`);
    }
    console.log('✓ Popup inline output editing updates status/quality and Undo reverts cleanly');


    // Save the result on screen to the library, with a name and labels.
    console.log('→ Testing Save to library from the Popup...');
    const popupSave = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        document.getElementById('save-btn').click();
        await wait(300);
        const title = document.getElementById('popup-save-title');
        const form = document.querySelector('#save-slot form');
        if (!title || !form || form.hidden) return { error: 'save sheet did not open' };
        const suggested = title.value;
        title.value = 'CSV parser script';
        document.getElementById('popup-save-labels').value = 'code, python';
        form.requestSubmit();
        await wait(500);
        const stored = await new Promise(r =>
          chrome.storage.local.get('promptcraft_library', x => r(x.promptcraft_library || [])));
        const first = stored[0];
        return {
          suggested,
          count: stored.length,
          title: first?.title,
          labels: first?.labels,
          original: first?.original,
          textLength: first?.text.length,
          sheetClosed: form.hidden
        };
      })()`
    });
    const ps = popupSave.result.value;
    console.log('✓ Popup save result:', ps);
    if (ps.error) throw new Error('Popup Save: ' + ps.error);
    if (!ps.suggested) throw new Error('The save sheet should suggest a name from the prompt.');
    if (ps.count !== 1 || ps.title !== 'CSV parser script') throw new Error('Popup save did not store the prompt: ' + JSON.stringify(ps));
    if (JSON.stringify(ps.labels) !== JSON.stringify(['code', 'python'])) throw new Error('Labels were not stored: ' + JSON.stringify(ps.labels));
    if (ps.original !== 'write a python script to parse csv files') throw new Error('The original draft was not recorded: ' + ps.original);
    if (!(ps.textLength > 50) || !ps.sheetClosed) throw new Error('Saved text or sheet state wrong: ' + JSON.stringify(ps));

    /* New popup features: engine setup card, Ask me first, refine availability,
       the credential warning, and fill-in library templates. */
    console.log('→ Checking setup card, Ask me first, secret warning and library templates in the popup...');
    await popupClient.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 600, deviceScaleFactor: 1, mobile: false });
    const assistRes = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(100); } return null; };
        const $ = id => document.getElementById(id);
        const out = {};

        // 1. No Nano in this browser and no key: the setup card says so.
        out.setupVisible = !(await until(() => !$('setup-card').hidden) === null);
        out.setupText = $('setup-text').textContent.slice(0, 60);

        // 2. Offline fallback results offer no refinements.
        out.refineHiddenOnFallback = document.querySelector('.pc-assist')?.hidden !== false
          || document.querySelector('.pc-assist__refine')?.hidden === true;

        // 3. Ask me first: questions, answer one, the draft gains the details.
        $('raw-prompt').value = 'plan a team offsite';
        $('ask-first-btn').click();
        const sheet = await until(() => !document.querySelector('.pc-clarify').hidden && document.querySelector('.pc-clarify'));
        out.questions = sheet ? [...sheet.querySelectorAll('.pc-clarify__q')].map(q => q.textContent) : [];
        out.clarifyNote = sheet?.querySelector('.pc-clarify__note')?.textContent || '';
        if (sheet) {
          sheet.querySelector('input').value = 'Twelve engineers, remote-first';
          sheet.querySelector('button[type="submit"]').click();
        }
        await until(() => $('status-message').textContent !== 'Optimizing…' && $('raw-prompt').value.includes('Details:'), 8000);
        await until(() => !$('result-text').hidden, 8000);
        out.draftAfterAnswers = $('raw-prompt').value;

        // 4. A credential in the draft is held back when it could leave the device.
        const engineSlot = document.querySelector('#engine-slot .pc-select');
        engineSlot.querySelector('.pc-select__trigger').click();
        await wait(200);
        engineSlot.querySelector('.pc-select__option[data-value="openai"]').click();
        await wait(300);
        $('raw-prompt').value = 'why does this fail: AKIAIOSFODNN7EXAMPLE';
        const before = $('result-text').textContent;
        $('optimize-btn').click();
        const notice = await until(() => { const n = document.querySelector('.pc-secret-notice'); return n && !n.hidden && n; }, 3000);
        out.secretShown = Boolean(notice);
        out.secretText = notice?.querySelector('.pc-callout__text')?.textContent || '';
        await wait(400);
        out.secretBlockedRun = $('result-text').textContent === before && $('status-message').textContent !== 'Optimizing…';
        engineSlot.querySelector('.pc-select__trigger').click();
        await wait(200);
        engineSlot.querySelector('.pc-select__option[data-value="nano"]').click();
        await wait(300);

        // 5. A saved template asks for its blank, then fills it in.
        const lib = await import(chrome.runtime.getURL('shared/library.js'));
        const tpl = await lib.saveToLibrary({ title: 'Status email', text: 'Write a status email to {{audience}} about the launch.', labels: ['email'] });
        $('library-toggle-btn').click();
        const item = await until(() => [...document.querySelectorAll('.pc-libpick__item')].find(b => b.textContent.includes('Status email')));
        out.blankBadge = item?.querySelector('.pc-badge')?.textContent || '';
        item?.click();
        await wait(200);
        const field = document.querySelector('.pc-libpick__fields input');
        out.fillLabel = document.querySelector('.pc-libpick__fields label')?.textContent || '';
        if (field) field.value = 'the board';
        document.querySelector('.pc-libpick__fill button[type="submit"]')?.click();
        await wait(300);
        out.templateResult = $('result-text').textContent;
        out.pickerClosed = document.querySelector('.pc-libpick').hidden;
        await lib.deleteLibraryEntry(tpl.id); // later tests expect only their own entries
        return out;
      })()`
    });
    const assist = assistRes.result.value || assistRes.result;
    console.log('  assist:', JSON.stringify(assist));
    if (!assist.setupVisible) throw new Error('Setup card should show when Nano is missing and no key is saved: ' + JSON.stringify(assist));
    if (!assist.refineHiddenOnFallback) throw new Error('Refine actions must not be offered on an offline fallback');
    if (assist.questions.length !== 3) throw new Error('Ask me first should show three questions: ' + JSON.stringify(assist.questions));
    if (!/Details:\n- .*Twelve engineers, remote-first/.test(assist.draftAfterAnswers)) {
      throw new Error('Answers were not folded into the draft: ' + JSON.stringify(assist.draftAfterAnswers));
    }
    if (!assist.secretShown || !/AWS access key/.test(assist.secretText) || !assist.secretBlockedRun) {
      throw new Error('A credential in the draft must be held back with a warning: ' + JSON.stringify(assist));
    }
    if (assist.blankBadge !== '1 blank' || assist.fillLabel !== 'audience' ||
        assist.templateResult !== 'Write a status email to the board about the launch.' || !assist.pickerClosed) {
      throw new Error('Library template fill failed: ' + JSON.stringify(assist));
    }
    console.log('✓ Popup: setup card, Ask me first, secret warning and library templates all behave');

    // Design picker in the Popup: the app bar carries a compact swatch trigger
    // that opens a named list of every design. Walk every one and check that
    // each renders its own tokens, not just that data-theme changed.
    console.log('→ Testing the ten-design picker in Popup...');
    const themeTestRes = await popupClient.send('Runtime.evaluate', {
      expression: `
        (async () => {
          const slot = document.querySelector('#theme-toggle-slot .pc-select');
          if (!slot) return { error: 'Design picker not mounted' };
          const trigger = slot.querySelector('.pc-select__trigger');
          const ids = [...slot.querySelectorAll('.pc-select__option')].map(o => o.dataset.value);
          const seen = [];
          for (const id of ids) {
            trigger.click();
            await new Promise(r => setTimeout(r, 60));
            slot.querySelector('.pc-select__option[data-value="' + id + '"]').click();
            await new Promise(r => setTimeout(r, 120));
            const cs = getComputedStyle(document.documentElement);
            seen.push({
              id,
              dataTheme: document.documentElement.getAttribute('data-theme'),
              accent: cs.getPropertyValue('--accent').trim(),
              canvas: cs.getPropertyValue('--bg-canvas').trim(),
              font: cs.getPropertyValue('--font-sans').trim(),
              radius: cs.getPropertyValue('--radius-md').trim(),
              bodyBg: getComputedStyle(document.body).backgroundColor,
              label: trigger.getAttribute('aria-label')
            });
          }
          return { ids, seen };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    const themeRes = themeTestRes.result.value;
    if (themeRes.error) throw new Error(`Design picker missing: ${JSON.stringify(themeRes)}`);
    console.log('✓ Popup design picker offered:', themeRes.ids.join(', '));
    if (themeRes.ids.length < DESIGN_COUNT) {
      throw new Error(`Expected the full design set in the picker, found ${themeRes.ids.length}`);
    }
    for (const row of themeRes.seen) {
      if (row.dataTheme !== row.id) throw new Error(`Picking "${row.id}" set data-theme="${row.dataTheme}"`);
      if (!row.accent || !row.canvas) throw new Error(`Design "${row.id}" did not resolve its tokens: ${JSON.stringify(row)}`);
      if (!row.label.includes(':')) throw new Error(`Compact trigger lost its accessible name: ${row.label}`);
    }
    const accents = new Set(themeRes.seen.map(r => r.accent));
    if (accents.size !== themeRes.ids.length) {
      throw new Error(`Designs are not visually distinct, accents: ${[...accents].join(', ')}`);
    }
    const terminal = themeRes.seen.find(r => r.id === 'terminal');
    const manuscript = themeRes.seen.find(r => r.id === 'manuscript');
    if (!/mono/i.test(terminal.font)) throw new Error(`Terminal should use a monospace face, got: ${terminal.font}`);
    if (!/serif|Georgia|Palatino/i.test(manuscript.font)) throw new Error(`Manuscript should use a serif face, got: ${manuscript.font}`);
    if (terminal.radius === themeRes.seen.find(r => r.id === 'sand').radius) {
      throw new Error('Terminal and Sand share a corner radius; designs must differ in shape.');
    }
    console.log(`✓ All ${DESIGN_COUNT} designs render distinct tokens; sample:`, {
      terminal: { font: terminal.font.slice(0, 28), radius: terminal.radius },
      manuscript: { font: manuscript.font.slice(0, 28), radius: manuscript.radius }
    });

    // The last pick must have persisted, since every surface follows storage.
    const persisted = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings.theme)))`
    });
    if (persisted.result.value !== themeRes.ids[themeRes.ids.length - 1]) {
      throw new Error(`Design choice was not persisted: ${persisted.result.value}`);
    }
    console.log(`✓ Design choice persisted: "${persisted.result.value}"`);

    // Leave the suite on the default so later steps start from a known state.
    await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        const slot = document.querySelector('#theme-toggle-slot .pc-select');
        slot.querySelector('.pc-select__trigger').click();
        await new Promise(r => setTimeout(r, 60));
        slot.querySelector('.pc-select__option[data-value="dark"]').click();
        await new Promise(r => setTimeout(r, 150));
      })()`
    });

    // Clear draft & reset workspace
    const clearCheck = await popupClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const clearBtn = document.getElementById('clear-draft-btn');
        const visibleBefore = !clearBtn.hidden;
        clearBtn.click();
        await new Promise(r => setTimeout(r, 150));
        const sess = await chrome.storage.session?.get?.('promptcraft_popup_session');
        return {
          visibleBefore,
          visibleAfter: !clearBtn.hidden,
          rawAfter: document.getElementById('raw-prompt').value,
          charCount: document.getElementById('char-counter').textContent,
          resultHidden: document.getElementById('result-text').hidden,
          placeholderHidden: document.getElementById('result-placeholder').hidden,
          sessionCleared: !sess || !sess.promptcraft_popup_session
        };
      })()`
    });
    const cc = clearCheck.result.value;
    if (!cc.visibleBefore || cc.visibleAfter || cc.rawAfter !== '' || cc.charCount !== '0' || !cc.resultHidden || cc.placeholderHidden || !cc.sessionCleared) {
      throw new Error(`Popup clear draft failed: ${JSON.stringify(cc)}`);
    }
    console.log('✓ Popup Clear draft resets input, result, undo, and session state');

    popupClient.close();

    // 5. Test Options Page
    console.log('\n[5/5] Testing Options Page & Settings Storage...');
    const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
    const optionsTabRes = await cdpFetch('/json/new', { method: 'PUT' });
    const optionsTab = await optionsTabRes.json();

    const optionsClient = await createCdpClient(optionsTab.webSocketDebuggerUrl);
    const optionsLoadErrors = [];
    const optionsHardErrors = [];
    optionsClient.onEvent((evt) => {
      if (evt.method === 'Runtime.exceptionThrown') {
        const msg = `Exception: ${evt.params.exceptionDetails?.text || JSON.stringify(evt.params.exceptionDetails)}`;
        optionsLoadErrors.push(msg);
        optionsHardErrors.push(msg);
      } else if (evt.method === 'Log.entryAdded') {
        const lvl = evt.params.entry?.level;
        const msg = `Log[${lvl}]: ${evt.params.entry?.text}`;
        if (lvl === 'error' || lvl === 'warning') optionsLoadErrors.push(msg);
        if (lvl === 'error') optionsHardErrors.push(msg);
      } else if (evt.method === 'Console.messageAdded') {
        const lvl = evt.params.message?.level;
        const msg = `Console[${lvl}]: ${evt.params.message?.text}`;
        if (lvl === 'error' || lvl === 'warning') optionsLoadErrors.push(msg);
        if (lvl === 'error') optionsHardErrors.push(msg);
      }
    });
    await optionsClient.send('Runtime.enable');
    await optionsClient.send('Page.enable');
    await optionsClient.send('Console.enable');
    await optionsClient.send('Log.enable');
    await optionsClient.send('Page.navigate', { url: optionsUrl });

    for (let r = 0; r < 20; r++) {
      const state = await optionsClient.send('Runtime.evaluate', {
        expression: 'window.location.href + " | " + document.readyState'
      });
      if (state.result.value.includes('options.html') && state.result.value.includes('complete')) break;
      await sleep(250);
    }
    await sleep(400);
    if (optionsLoadErrors.length > 0) {
      throw new Error(`Options emitted console/runtime errors on load: ${JSON.stringify(optionsLoadErrors)}`);
    }

    const optTitle = await optionsClient.send('Runtime.evaluate', {
      expression: 'document.querySelector(".pc-brand__name")?.textContent'
    });
    console.log(`✓ Options Page Loaded: "${optTitle.result.value}"`);


    // Top of the page: the logo and the yourlegalaid wordmark, at the same size.
    const lockupOptions = await optionsClient.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const box = document.querySelector('.pc-lockup');
        const logo = document.querySelector('.pc-lockup__logo');
        const word = document.querySelector('.pc-lockup__word');
        if (!box || !logo || !word) return { error: 'lockup missing' };
        const lr = logo.getBoundingClientRect();
        const wr = word.getBoundingClientRect();
        const ws = getComputedStyle(word);
        return {
          first: document.body.firstElementChild === box || box.getBoundingClientRect().top <= 1,
          loaded: logo.complete && logo.naturalWidth > 0,
          transparent: true,
          logoHeight: Math.round(lr.height),
          wordFontSize: parseFloat(ws.fontSize),
          wordLineHeight: parseFloat(ws.lineHeight),
          wordText: word.textContent.trim(),
          appName: document.querySelector('.pc-brand__name')?.textContent.trim(),
          docTitle: document.title
        };
      })()`
    });
    const lkOptions = lockupOptions.result.value;
    console.log('✓ Options lockup:', lkOptions);
    if (lkOptions.error) throw new Error('Options: ' + lkOptions.error);
    if (!lkOptions.first) throw new Error('Options: the lockup must be at the very top of the page');
    if (!lkOptions.loaded) throw new Error('Options: the logo image did not load');
    if (lkOptions.wordText !== 'yourlegalaid') throw new Error('Options: wordmark text is "' + lkOptions.wordText + '"');
    if (lkOptions.logoHeight !== lkOptions.wordFontSize || lkOptions.wordFontSize !== lkOptions.wordLineHeight) {
      throw new Error('Options: logo and wordmark differ in size: ' + JSON.stringify(lkOptions));
    }
    if (lkOptions.appName !== 'PromptOptimizer') throw new Error('Options: app name is "' + lkOptions.appName + '"');

    // Console shell: nav, sections, theme picker, Nano check button & zero page errors
    const shellCheck = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        const checkBtn = document.getElementById('nano-check-btn');
        const statusBefore = document.getElementById('nano-status-text')?.textContent || '';
        const checkVisible = Boolean(checkBtn && !checkBtn.hidden);
        checkBtn?.click();
        await new Promise(r => setTimeout(r, 150));
        const statusAfter = document.getElementById('nano-status-text')?.textContent || '';
        return {
          sections: document.querySelectorAll('.pc-section').length,
          navItems: document.querySelectorAll('.pc-nav__item').length,
          themePicker: Boolean(document.querySelector('#theme-picker-slot .pc-select')),
          engineSelect: Boolean(document.querySelector('#preferred-engine-slot .pc-select')),
          frameworkCards: document.querySelectorAll('.pc-framework').length,
          omniSection: Boolean(document.getElementById('omniroute-base-url') && document.getElementById('omniroute-enabled') && document.getElementById('omniroute-model')),
          openrouterFilter: Boolean(document.getElementById('openrouter-all-models-toggle') && document.getElementById('openrouter-model-filter')),
          fallbackRows: Boolean(document.getElementById('fallback-1-row') && document.getElementById('fallback-2-row')),
          historyNav: Boolean(document.getElementById('history-nav-link')),
          nanoCheckVisible: checkVisible,
          nanoStatusBefore: statusBefore,
          nanoStatusAfter: statusAfter
        };
      })()`,
      returnByValue: true
    });
    console.log('✓ Options console structure:', shellCheck.result.value);
    if (optionsHardErrors.length > 0) {
      throw new Error(`Options emitted uncaught errors: ${JSON.stringify(optionsHardErrors)}`);
    }
    if (
      shellCheck.result.value.sections !== 7 ||
      shellCheck.result.value.navItems !== 7 ||
      !shellCheck.result.value.themePicker ||
      !shellCheck.result.value.omniSection ||
      !shellCheck.result.value.openrouterFilter ||
      !shellCheck.result.value.fallbackRows ||
      !shellCheck.result.value.historyNav ||
      !shellCheck.result.value.nanoCheckVisible ||
      !/Unavailable|Disabled by browser flag/i.test(shellCheck.result.value.nanoStatusAfter)
    ) {
      throw new Error('Options console did not render all expected v5 sections/controls: ' + JSON.stringify(shellCheck.result.value));
    }

    // Test dirty tracking, preset bindings, clamping, privacy toggle, and Ctrl+S saving
    const saveFlowRes = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const $ = id => document.getElementById(id);
        const initialClean = $('save-status-text').textContent === 'Saved locally' && !$('save-status').classList.contains('is-dirty');

        // Dirty tracking + custom prompt
        $('custom-system-prompt').value = 'Always enforce clean architecture and unit tests.';
        $('custom-system-prompt').dispatchEvent(new Event('input', { bubbles: true }));

        // Strict local Nano toggle + maxHistory clamping
        $('allow-cloud-fallback').checked = false;
        $('allow-cloud-fallback').dispatchEvent(new Event('change', { bubbles: true }));
        $('max-history').value = '250';
        $('max-history').dispatchEvent(new Event('change', { bubbles: true }));
        const clampedHistoryInput = $('max-history').value;

        // Provider preset bidirectional sync (Gemini & OmniRoute)
        const omniPreset = document.querySelector('#omniroute-model-slot .pc-select');
        omniPreset.querySelector('.pc-select__trigger').click();
        await wait(60);
        omniPreset.querySelector('.pc-select__option[data-value="auto/coding:free"]')?.click();
        await wait(60);
        const omniPresetSyncedInput = $('omniroute-model').value;
        $('omniroute-model').value = 'custom-route-test';
        $('omniroute-model').dispatchEvent(new Event('input', { bubbles: true }));
        const omniCustomPresetVal = omniPreset.dataset.value;
        $('omniroute-model').value = 'auto';
        $('omniroute-model').dispatchEvent(new Event('input', { bubbles: true }));

        const gemPreset = document.querySelector('#gemini-model-slot .pc-select');
        gemPreset.querySelector('.pc-select__trigger').click();
        await wait(60);
        gemPreset.querySelector('.pc-select__option[data-value="gemini-2.5-pro"]')?.click();
        await wait(60);

        // OpenRouter filter test (does not mutate selection)
        const filterInput = $('openrouter-model-filter');
        filterInput.value = 'zzz-nonexistent';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));
        const orFilteredCount = document.querySelectorAll('#openrouter-model-slot .pc-select__option').length;
        filterInput.value = '';
        filterInput.dispatchEvent(new Event('input', { bubbles: true }));

        const dirtyShown = $('save-status-text').textContent === 'Unsaved changes' && $('save-status').classList.contains('is-dirty');

        // Save via Ctrl+S shortcut
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
        await wait(500);
        const savedCleanAfterCtrlS = $('save-status-text').textContent === 'Saved locally' && !$('save-status').classList.contains('is-dirty');

        const afterFirstSave = await new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings)));

        // Restore allowCloudFallback = true & maxHistoryItems = 20 via Save button
        $('allow-cloud-fallback').checked = true;
        $('allow-cloud-fallback').dispatchEvent(new Event('change', { bubbles: true }));
        $('max-history').value = '20';
        $('max-history').dispatchEvent(new Event('change', { bubbles: true }));
        $('save-btn').click();
        await wait(400);

        return {
          initialClean,
          clampedHistoryInput,
          omniPresetSyncedInput,
          omniCustomPresetVal,
          orFilteredCount,
          dirtyShown,
          savedCleanAfterCtrlS,
          customPrompt: afterFirstSave.customSystemPrompt,
          cloudFallbackSavedFalse: afterFirstSave.allowCloudFallback === false,
          maxHistorySaved100: afterFirstSave.maxHistoryItems === 100,
          geminiModelSaved: afterFirstSave.geminiModel
        };
      })()`
    });
    const sf = saveFlowRes.result.value;
    if (
      !sf.initialClean ||
      sf.clampedHistoryInput !== '100' ||
      sf.omniPresetSyncedInput !== 'auto/coding:free' ||
      sf.omniCustomPresetVal !== '__custom__' ||
      sf.orFilteredCount !== 1 ||
      !sf.dirtyShown ||
      !sf.savedCleanAfterCtrlS ||
      sf.customPrompt !== 'Always enforce clean architecture and unit tests.' ||
      !sf.cloudFallbackSavedFalse ||
      !sf.maxHistorySaved100 ||
      sf.geminiModelSaved !== 'gemini-2.5-pro'
    ) {
      throw new Error(`Options save/dirty/presets/clamping failed: ${JSON.stringify(sf)}`);
    }
    console.log(`✓ Options dirty tracking, Ctrl+S save, privacy toggle, clamping, and presets verified`);

    // Ordered Fallback 1 & Fallback 2 controls, disabled model rules, presets, custom IDs, hints, and reload persistence
    const fbFlowRes = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const $ = id => document.getElementById(id);
        const pick = async (slotSel, val) => {
          const sel = document.querySelector(slotSel + ' .pc-select');
          sel.querySelector('.pc-select__trigger').click();
          await wait(60);
          const opt = sel.querySelector('.pc-select__option[data-value="' + val + '"]');
          if (!opt) throw new Error('Missing option ' + val + ' in ' + slotSel);
          opt.click();
          await wait(60);
        };

        const fb1Input = $('fallback-1-model');
        const fb2Input = $('fallback-2-model');
        const fb1Trigger = () => document.querySelector('#fallback-1-preset-slot .pc-select__trigger');
        const fb2Trigger = () => document.querySelector('#fallback-2-preset-slot .pc-select__trigger');
        const initialDisabled = fb1Input.disabled && fb2Input.disabled && fb1Trigger().disabled && fb2Trigger().disabled;

        await pick('#fallback-1-engine-slot', 'nano');
        const nanoDisabled = fb1Input.disabled && fb1Trigger().disabled;
        const nanoHint = $('fallback-1-hint').textContent;

        await pick('#fallback-1-engine-slot', 'offline');
        const offlineDisabled = fb1Input.disabled && fb1Trigger().disabled;
        const offlineFb2Hint = $('fallback-2-hint').textContent;

        await pick('#fallback-1-engine-slot', 'openai');
        const openaiEnabled = !fb1Input.disabled && !fb1Trigger().disabled;
        await pick('#fallback-1-preset-slot', 'gpt-4.1');
        const fb1PresetVal = fb1Input.value;

        await pick('#fallback-2-engine-slot', 'omniroute');
        const omniEnabled = !fb2Input.disabled && !fb2Trigger().disabled;
        fb2Input.value = 'custom-omni-route:free';
        fb2Input.dispatchEvent(new Event('input', { bubbles: true }));
        const omniCustomPreset = document.querySelector('#fallback-2-preset-slot .pc-select').dataset.value;
        const omniHint = $('fallback-2-hint').textContent;

        // Save OpenAI preset + OpenRouter custom override so save needs no OmniRoute permission dialog in headless Chromium
        await pick('#fallback-2-engine-slot', 'openrouter');
        fb2Input.value = 'meta-llama/custom-fallback-test';
        fb2Input.dispatchEvent(new Event('input', { bubbles: true }));
        const orCustomPreset = document.querySelector('#fallback-2-preset-slot .pc-select').dataset.value;
        $('save-btn').click();
        await wait(500);

        const stored = await new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings)));
        return {
          initialDisabled,
          nanoDisabled,
          nanoHint,
          offlineDisabled,
          offlineFb2Hint,
          openaiEnabled,
          fb1PresetVal,
          omniEnabled,
          omniCustomPreset,
          omniHint,
          orCustomPreset,
          stored
        };
      })()`
    });
    const fbf = fbFlowRes.result.value;
    if (
      !fbf.initialDisabled ||
      !fbf.nanoDisabled ||
      !/Matches Default engine \(Chrome Nano\)/.test(fbf.nanoHint) ||
      !fbf.offlineDisabled ||
      !/Skipped because Fallback 1 stops/.test(fbf.offlineFb2Hint) ||
      !fbf.openaiEnabled ||
      fbf.fb1PresetVal !== 'gpt-4.1' ||
      !fbf.omniEnabled ||
      fbf.omniCustomPreset !== '__custom__' ||
      !/OmniRoute \(custom-omni-route:free\)/.test(fbf.omniHint) ||
      fbf.orCustomPreset !== '__custom__' ||
      fbf.stored.fallback1Engine !== 'openai' ||
      fbf.stored.fallback1Model !== 'gpt-4.1' ||
      fbf.stored.fallback2Engine !== 'openrouter' ||
      fbf.stored.fallback2Model !== 'meta-llama/custom-fallback-test'
    ) {
      throw new Error(`Options fallback controls failed: ${JSON.stringify(fbf)}`);
    }

    // Reload Options to confirm ordered fallback slots + presets restore cleanly from storage, then reset to defaults.
    await optionsClient.send('Page.reload');
    for (let r = 0; r < 25; r++) {
      const state = await optionsClient.send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + (document.querySelector("#fallback-1-engine-slot .pc-select")?.dataset.value || "")'
      });
      if (state.result.value === 'complete|openai') break;
      await sleep(200);
    }
    await sleep(300);

    const fbReloadRes = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const $ = id => document.getElementById(id);
        const restored = {
          fb1Engine: document.querySelector('#fallback-1-engine-slot .pc-select')?.dataset.value,
          fb1Model: $('fallback-1-model').value,
          fb1Preset: document.querySelector('#fallback-1-preset-slot .pc-select')?.dataset.value,
          fb1Disabled: $('fallback-1-model').disabled,
          fb2Engine: document.querySelector('#fallback-2-engine-slot .pc-select')?.dataset.value,
          fb2Model: $('fallback-2-model').value,
          fb2Preset: document.querySelector('#fallback-2-preset-slot .pc-select')?.dataset.value,
          fb2Disabled: $('fallback-2-model').disabled
        };
        const resetSlot = async slotSel => {
          const sel = document.querySelector(slotSel + ' .pc-select');
          sel.querySelector('.pc-select__trigger').click();
          await wait(60);
          sel.querySelector('.pc-select__option[data-value=""]')?.click();
          await wait(60);
        };
        await resetSlot('#fallback-1-engine-slot');
        await resetSlot('#fallback-2-engine-slot');
        $('save-btn').click();
        await wait(500);
        const afterReset = await new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings)));
        return { restored, afterReset };
      })()`
    });
    const fbr = fbReloadRes.result.value;
    if (
      fbr.restored.fb1Engine !== 'openai' ||
      fbr.restored.fb1Model !== 'gpt-4.1' ||
      fbr.restored.fb1Preset !== 'gpt-4.1' ||
      fbr.restored.fb1Disabled !== false ||
      fbr.restored.fb2Engine !== 'openrouter' ||
      fbr.restored.fb2Model !== 'meta-llama/custom-fallback-test' ||
      fbr.restored.fb2Preset !== '__custom__' ||
      fbr.restored.fb2Disabled !== false ||
      fbr.afterReset.fallback1Engine !== '' ||
      fbr.afterReset.fallback1Model !== '' ||
      fbr.afterReset.fallback2Engine !== '' ||
      fbr.afterReset.fallback2Model !== ''
    ) {
      throw new Error(`Options fallback reload persistence failed: ${JSON.stringify(fbr)}`);
    }
    console.log('✓ Options ordered Fallback 1 & Fallback 2 controls, disabled states, custom IDs, hints, and reload persistence verified');

    // Test Adding a New Custom Optimizer Framework
    console.log('\n→ Testing "Add New Optimizer Type" in Options...');
    await optionsClient.send('Runtime.evaluate', {
      expression: `
        (async () => {
          document.getElementById('add-framework-btn').click();
          // Icon is a design-system select now, not a free-text glyph field.
          const iconTrigger = document.querySelector('#fw-icon-slot .pc-select__trigger');
          if (iconTrigger) {
            iconTrigger.click();
            await new Promise(r => setTimeout(r, 80));
            const opt = document.querySelector('#fw-icon-slot .pc-select__option[data-value="shield"]');
            if (opt) opt.click();
          }
          document.getElementById('fw-name').value = 'Security Auditor';
          document.getElementById('fw-tagline').value = 'Performs strict threat modeling and vulnerability checks';
          document.getElementById('fw-system-prompt').value = 'You are a Chief Information Security Officer. Perform thorough threat modeling.';
          document.getElementById('fw-template').value = '### SECURITY REVIEW AUDIT\\nTarget System: {{prompt}}\\nPersona: {{persona}}\\nDeliverable: {{deliverable}}';
          document.getElementById('save-framework-btn').click();
        })()
      `,
      awaitPromise: true
    });
    await sleep(600);

    // Verify the new framework exists in the rendered cards and storage
    const customFwCheck = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `
        new Promise(resolve => {
          chrome.storage.local.get('promptcraft_frameworks', res => {
            const fw = (res.promptcraft_frameworks || []).find(f => f.name === 'Security Auditor');
            resolve(fw ? { found: true, icon: fw.icon, id: fw.id } : { found: false });
          });
        })
      `,
      returnByValue: true
    });
    console.log('✓ Custom Optimizer Framework Created & Persisted:', customFwCheck.result.value);

    // Library: the prompt saved from the popup is listed; add, filter, search, edit, refuse empty, delete.
    console.log('→ Testing the saved-prompt Library in Options...');
    const libRes = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        window.confirm = () => true;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const titles = () => [...document.querySelectorAll('#library-list .pc-saved__title')].map(t => t.textContent);
        const out = {};
        await wait(400);
        out.initial = titles();
        out.nav = Boolean(document.querySelector('.pc-nav__item[href="#sec-library"]'));

        document.getElementById('add-prompt-btn').click();
        await wait(150);
        out.modalOpen = !document.getElementById('prompt-modal-backdrop').hidden;
        out.suggestedChips = [...document.querySelectorAll('#pm-label-chips .pc-labelchip')].map(c => c.dataset.label);
        document.getElementById('pm-title').value = 'Weekly status update';
        document.getElementById('pm-labels').value = 'writing, work';
        document.getElementById('pm-text').value = 'Draft a weekly status update for my manager.';
        document.getElementById('save-prompt-btn').click();
        await wait(600);
        out.afterAdd = titles();
        out.modalClosed = document.getElementById('prompt-modal-backdrop').hidden;
        out.chips = [...document.querySelectorAll('#library-labels .pc-labelchip')].map(c => c.dataset.label);

        document.querySelector('#library-labels .pc-labelchip[data-label="writing"]').click();
        await wait(150);
        out.filtered = titles();
        document.querySelector('#library-labels .pc-labelchip[data-label=""]').click();
        await wait(150);

        const search = document.getElementById('library-search');
        search.value = 'PYTHON';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(150);
        out.searched = titles();
        search.value = 'zzz-no-match';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(150);
        out.noMatch = document.querySelector('#library-list .pc-library__empty strong')?.textContent;
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(150);

        const find = name => [...document.querySelectorAll('#library-list .pc-saved')]
          .find(c => c.querySelector('.pc-saved__title').textContent === name);
        find('Weekly status update').querySelector('[data-action="edit"]').click();
        await wait(150);
        out.editPrefill = {
          title: document.getElementById('pm-title').value,
          labels: document.getElementById('pm-labels').value
        };
        document.getElementById('pm-title').value = 'Weekly status report';
        document.getElementById('save-prompt-btn').click();
        await wait(600);
        out.afterEdit = titles();

        document.getElementById('add-prompt-btn').click();
        await wait(150);
        document.getElementById('pm-title').value = 'Empty one';
        document.getElementById('pm-text').value = '   ';
        document.getElementById('save-prompt-btn').click();
        await wait(300);
        out.emptyKeptOpen = !document.getElementById('prompt-modal-backdrop').hidden;
        out.emptyMessage = document.getElementById('toast').textContent;
        document.getElementById('cancel-prompt-btn').click();
        await wait(150);

        find('Weekly status report').querySelector('[data-action="delete"]').click();
        await wait(600);
        out.afterDelete = titles();
        return out;
      })()`
    });
    const lr = libRes.result.value;
    console.log('✓ Library flow:', JSON.stringify(lr));
    if (!lr.nav) throw new Error('Library is missing from the Options navigation.');
    if (JSON.stringify(lr.initial) !== JSON.stringify(['CSV parser script'])) throw new Error('Popup-saved prompt not listed in Options: ' + JSON.stringify(lr.initial));
    if (!lr.modalOpen || !lr.modalClosed) throw new Error('Editor modal did not open and close: ' + JSON.stringify(lr));
    if (!lr.suggestedChips.includes('code')) throw new Error('Existing labels were not offered as chips: ' + JSON.stringify(lr.suggestedChips));
    if (lr.afterAdd.length !== 2 || !lr.afterAdd.includes('Weekly status update')) throw new Error('New prompt not added: ' + JSON.stringify(lr.afterAdd));
    if (!['', 'writing', 'work', 'code', 'python'].every(l => lr.chips.includes(l))) throw new Error('Label filter chips incomplete: ' + JSON.stringify(lr.chips));
    if (JSON.stringify(lr.filtered) !== JSON.stringify(['Weekly status update'])) throw new Error('Label filter wrong: ' + JSON.stringify(lr.filtered));
    if (JSON.stringify(lr.searched) !== JSON.stringify(['CSV parser script'])) throw new Error('Search wrong: ' + JSON.stringify(lr.searched));
    if (lr.noMatch !== 'No prompts match') throw new Error('Empty search state wrong: ' + lr.noMatch);
    if (lr.editPrefill.title !== 'Weekly status update' || lr.editPrefill.labels !== 'writing, work') throw new Error('Edit did not prefill: ' + JSON.stringify(lr.editPrefill));
    if (!lr.afterEdit.includes('Weekly status report') || lr.afterEdit.includes('Weekly status update')) throw new Error('Edit not applied: ' + JSON.stringify(lr.afterEdit));
    if (!lr.emptyKeptOpen || !/empty/i.test(lr.emptyMessage)) throw new Error('Empty prompt should be refused with a message: ' + JSON.stringify([lr.emptyKeptOpen, lr.emptyMessage]));
    if (JSON.stringify(lr.afterDelete) !== JSON.stringify(['CSV parser script'])) throw new Error('Delete did not remove the prompt: ' + JSON.stringify(lr.afterDelete));
    console.log('✓ Library: list, add, label filter, search, edit, empty refusal and delete all behave');

    // History section & Export buttons in Options
    console.log('→ Testing History management and Export buttons in Options...');
    const histExportRes = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const rows = () => [...document.querySelectorAll('#history-options-list .pc-history-entry')];
        const initialCount = rows().length;
        const search = document.getElementById('history-search');
        search.value = 'python';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);
        const filteredCount = rows().length;
        search.value = 'zzz-no-history-match';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);
        const emptyTitle = document.querySelector('#history-options-list .pc-library__empty strong')?.textContent || '';
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);

        rows()[0]?.querySelector('[data-action="delete"]')?.click();
        await wait(350);
        const afterDeleteCount = rows().length;

        document.getElementById('export-frameworks-btn').click();
        await wait(150);
        const fwExportToast = document.getElementById('toast').textContent;
        document.getElementById('export-library-btn').click();
        await wait(150);
        const libExportToast = document.getElementById('toast').textContent;
        return { initialCount, filteredCount, emptyTitle, afterDeleteCount, fwExportToast, libExportToast };
      })()`
    });
    const he = histExportRes.result.value;
    if (
      he.initialCount < 1 ||
      he.filteredCount < 1 ||
      he.emptyTitle !== 'No matching history entries' ||
      he.afterDeleteCount !== he.initialCount - 1 ||
      !/Exported \d+ optimizer/.test(he.fwExportToast) ||
      !/Exported \d+ saved prompt/.test(he.libExportToast)
    ) {
      throw new Error(`Options history / export check failed: ${JSON.stringify(he)}`);
    }
    console.log('✓ Options history list/search/delete and export buttons verified');

    // Quick-repair Step 1 toggle in Options
    const qrRes = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const toggle = document.getElementById('quick-repair-enabled');
        const initialChecked = toggle.checked;
        toggle.click();
        document.getElementById('save-btn').click();
        await wait(350);
        const afterUncheck = await new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings?.quickRepairEnabled)));
        toggle.click();
        document.getElementById('save-btn').click();
        await wait(350);
        const afterRecheck = await new Promise(r => chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings?.quickRepairEnabled)));
        return { initialChecked, afterUncheck, afterRecheck };
      })()`
    });
    const qrr = qrRes.result.value;
    if (qrr.initialChecked !== true || qrr.afterUncheck !== false || qrr.afterRecheck !== true) {
      throw new Error(`Options quick-repair toggle check failed: ${JSON.stringify(qrr)}`);
    }
    console.log('✓ Options quick-repair Step 1 toggle persistence verified');

    optionsClient.close();

    // 6. Test Content Script & Floating In-Page Widget
    console.log('\n[6/6] Testing Content Script & In-Page Floating Widget on Mock Chat Interface...');
    const http = require('http');
    const pendingMockTimers = new Set();
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let sys = '';
          let userMsg = '';
          try {
            const parsed = JSON.parse(body || '{}');
            const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
            sys = String(msgs.find(m => m.role === 'system')?.content || '');
            userMsg = String(msgs.find(m => m.role === 'user')?.content || '');
          } catch {}
          const rawMatch = userMsg.match(/<raw_prompt>\n?([\s\S]*?)\n?<\/raw_prompt>/);
          const draft = (rawMatch ? rawMatch[1] : userMsg).trim();
          const isRepair = sys.includes('copy-editor repairing');

          const respondJson = (content, delayMs = 0) => {
            const sendPayload = () => {
              if (res.writableEnded || res.destroyed) return;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ choices: [{ message: { content } }] }));
            };
            if (delayMs > 0) {
              const t = setTimeout(() => {
                pendingMockTimers.delete(t);
                sendPayload();
              }, delayMs);
              pendingMockTimers.add(t);
              const cancelTimer = () => { clearTimeout(t); pendingMockTimers.delete(t); };
              res.on('close', cancelTimer);
            } else {
              sendPayload();
            }
          };

          if (isRepair) {
            if (draft.includes('__SLOW_STEP1__')) {
              respondJson(draft, 1500);
              return;
            }
            if (draft === '__SLOW_STEP2__ helo wrld') {
              respondJson('__SLOW_STEP2__ hello world', 0);
              return;
            }
            if (draft === 'wrte a tst for lgoin') {
              respondJson('write a test for login', 0);
              return;
            }
            if (draft === 'helo  gemni\n\npls expln async') {
              respondJson('hello  gemini\n\nplease explain async', 0);
              return;
            }
            respondJson(draft, 0);
            return;
          }

          if (draft.includes('__SLOW_STEP2__')) {
            respondJson(`ENHANCED_MOCK: ${draft}`, 1500);
            return;
          }
          if (draft.includes('__SLOW_EDIT__')) {
            respondJson(`ENHANCED_MOCK: ${draft}`, 400);
            return;
          }
          if (draft === 'hello  gemini\n\nplease explain async') {
            respondJson('### ROLE\nSenior engineer\n\n### TASK\n1. Explain event loop\n2. Compare promises', 0);
            return;
          }
          respondJson(`ENHANCED_MOCK: ${draft}`, 0);
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (req.url && req.url.startsWith('/gemini')) {
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Mock Gemini Quill Composer</title>
            <style>
              body { margin: 0; font-family: system-ui, sans-serif; }
              #gemini-stage { padding: 80px 24px; }
              .input-area {
                display: flex;
                align-items: flex-end;
                gap: 10px;
                width: 680px;
                max-width: 100%;
                box-sizing: border-box;
                border: 1px solid #999;
                border-radius: 24px;
                padding: 12px 16px;
                background: #fff;
              }
              .text-input-field { flex: 1; min-width: 0; }
              .ql-editor {
                white-space: pre-wrap;
                word-wrap: break-word;
                min-height: 44px;
                line-height: 1.4;
                outline: none;
              }
              .ql-editor p { margin: 0; padding: 0; }
            </style>
          </head>
          <body>
            <div id="gemini-stage">
              <input-area-v2 id="gemini-composer">
                <div class="input-area">
                  <div class="text-input-field">
                    <rich-textarea>
                      <div id="ql" class="ql-editor ql-blank textarea" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini"><p><br></p></div>
                    </rich-textarea>
                  </div>
                  <button id="gemini-mic" class="mic-button" type="button" style="width: 36px; height: 36px; flex-shrink: 0;">Mic</button>
                  <button id="gemini-send" class="send-button" type="button" disabled style="width: 36px; height: 36px; flex-shrink: 0;">Send</button>
                </div>
              </input-area-v2>
            </div>
            <script>
              const ql = document.getElementById('ql');
              const sendBtn = document.getElementById('gemini-send');
              window.__pasteEvents = 0;
              ql.addEventListener('paste', () => { window.__pasteEvents += 1; });

              let normalizing = false;
              const syncQuillUi = () => {
                const text = (ql.innerText || '').trim();
                const isBlank = text.length === 0;
                ql.classList.toggle('ql-blank', isBlank);
                sendBtn.disabled = isBlank;
              };

              new MutationObserver(() => {
                syncQuillUi();
                if (normalizing) return;
                queueMicrotask(() => {
                  normalizing = true;
                  try {
                    // Simulate Quill asynchronously converting double spaces into space + NBSP.
                    const walker = document.createTreeWalker(ql, NodeFilter.SHOW_TEXT);
                    let tn;
                    while ((tn = walker.nextNode())) {
                      if (tn.nodeValue && tn.nodeValue.includes('  ')) {
                        tn.nodeValue = tn.nodeValue.replace(/  /g, ' \\u00a0');
                      }
                    }
                    if (!ql.querySelector('p')) {
                      const p = document.createElement('p');
                      p.appendChild(document.createElement('br'));
                      ql.replaceChildren(p);
                    }
                    syncQuillUi();
                  } finally {
                    normalizing = false;
                  }
                });
              }).observe(ql, { childList: true, subtree: true, characterData: true });

              sendBtn.addEventListener('click', () => {
                const p = document.createElement('p');
                p.appendChild(document.createElement('br'));
                ql.replaceChildren(p);
                syncQuillUi();
              });
            </script>
          </body>
          </html>
        `);
        return;
      }
      if (req.url && req.url.startsWith('/composer')) {
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Composer Fixture</title></head>
          <body style="padding: 80px;">
            <div class="input-area" id="composer-shell" style="width: 560px; display: flex; align-items: center; gap: 10px; border: 1px solid #999; border-radius: 16px; padding: 12px 16px;">
              <textarea id="prompt-textarea" style="display: none;"></textarea>
              <div id="ce-input" contenteditable="true" role="textbox" style="flex: 1; min-height: 44px; outline: none;"></div>
              <button id="send-btn" type="button" style="width: 72px; height: 34px;">Send</button>
            </div>
          </body>
          </html>
        `);
        return;
      }
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Mock AI Chat</title></head>
        <body style="padding: 50px;">
          <h1>Mock AI Chat Interface</h1>
          <div id="chat-scroller" style="margin-top: 60px; height: 220px; overflow-y: auto; border: 1px solid #888; padding: 16px;">
            <textarea id="prompt-textarea" style="width: 400px; height: 100px;" placeholder="Message ChatGPT..."></textarea>
            <div style="height: 600px;">Spacer content</div>
          </div>
          <div style="margin-top: 40px;">
            <input id="login-password" type="password" value="hunter2-do-not-read">
            <input id="login-token" type="text" name="otp_code" value="123456">
          </div>
        </body>
        </html>
      `);
    });

    await new Promise(r => server.listen(8765, '127.0.0.1', r));

    try {
      const pageTabRes = await cdpFetch('/json/new', { method: 'PUT' });
      const pageTab = await pageTabRes.json();

      const pageClient = await createCdpClient(pageTab.webSocketDebuggerUrl);
      let isolatedContextId = null;

      pageClient.onEvent((evt) => {
        if (evt.method === 'Runtime.executionContextCreated') {
          const ctx = evt.params.context;
          if (ctx.auxData && !ctx.auxData.isDefault) {
            isolatedContextId = ctx.id;
            console.log(`✓ Detected Extension Isolated World Context ID: ${isolatedContextId} (${ctx.name})`);
          }
        } else if (evt.method === 'Runtime.consoleAPICalled') {
          console.log('  [Content Script Console]:', evt.params.type, evt.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' '));
        } else if (evt.method === 'Console.messageAdded') {
          console.log('  [Page Console]:', evt.params.message.text);
        } else if (evt.method === 'Runtime.exceptionThrown') {
          console.error('  [Page Exception]:', evt.params.exceptionDetails);
        }
      });

      await pageClient.send('Runtime.enable');
      await pageClient.send('Page.enable');
      await pageClient.send('Console.enable');
      // A headless page is not focused, so element.focus() would not fire focus
      // events and the star button focus/blur logic would go untested.
      await pageClient.send('Emulation.setFocusEmulationEnabled', { enabled: true });

      await pageClient.send('Page.navigate', { url: 'http://127.0.0.1:8765/chat' });
      await sleep(1200);

      // Verify content script injected Shadow DOM root
      const hostCheck = await pageClient.send('Runtime.evaluate', {
        expression: 'Boolean(document.getElementById("promptcraft-root-host")?.shadowRoot)'
      });
      console.log(`✓ PromptOptimizer Shadow DOM Injected into Chat Page: ${hostCheck.result.value}`);

      // Helper to evaluate in isolated world
      const evalInIsolated = (expr, awaitPromise = false) => pageClient.send('Runtime.evaluate', {
        expression: expr,
        contextId: isolatedContextId || undefined,
        returnByValue: true,
        awaitPromise
      });

      // Helper to open the in-page modal via the service worker command route
      const openModalViaSwCommand = async (urlFragment) => {
        await evalInIsolated(`chrome.runtime.sendMessage({ type: 'GET_STATUS' }).catch(() => {})`, true);
        let activeSw = swClient;
        const probeSw = async client => {
          if (!client) return false;
          try {
            await client.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
            return true;
          } catch {
            return false;
          }
        };
        if (!(await probeSw(activeSw))) {
          const targetsRes = await cdpFetch('/json/list');
          const targets = await targetsRes.json();
          const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('background/service-worker.js'));
          if (!sw?.webSocketDebuggerUrl) throw new Error('Service worker target unavailable for modal open command');
          activeSw = await createCdpClient(sw.webSocketDebuggerUrl);
          await activeSw.send('Runtime.enable');
          swClient = activeSw;
        }
        await activeSw.send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
            const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
            const tab = tabs.find(t => (t.url || '').includes(${JSON.stringify(urlFragment)})) || tabs[0];
            if (!tab?.id) throw new Error('No matching test tab found');
            await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_OPTIMIZER_MODAL', payload: { fromShortcut: true } });
            return tab.id;
          })()`
        });
      };

      // Focus the textarea to verify ONLY the floating star button renders (no Optimize pill)
      console.log('→ Focusing chat textarea #prompt-textarea...');
      await pageClient.send('Runtime.evaluate', {
        expression: `
          const ta = document.getElementById('prompt-textarea');
          ta.value = 'build a rest api in go';
          ta.focus();
        `
      });
      await sleep(400);

      // Verify legacy Optimize pill does NOT exist and floating star button sits on the far right
      const starOnlyCheck = await evalInIsolated(`
        (() => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const legacyPill = shadow.querySelector('#pc-trigger, .pc-trigger-pill');
          const star = shadow.querySelector('#pc-star-btn');
          const ta = document.getElementById('prompt-textarea');
          const sRect = star.getBoundingClientRect();
          const taRect = ta.getBoundingClientRect();
          return {
            hasLegacyPill: Boolean(legacyPill),
            starDisplay: star.style.display,
            starHasSvg: Boolean(star.querySelector('svg')),
            starOnFarRight: sRect.left >= taRect.right - 2,
            starInViewport: sRect.right <= window.innerWidth && sRect.bottom <= window.innerHeight && sRect.left >= 0 && sRect.top >= 0
          };
        })()
      `);
      const sc = starOnlyCheck.result.value;
      console.log(`✓ Floating Star Button Only (no legacy Optimize pill): display="${sc.starDisplay}", hasLegacyPill=${sc.hasLegacyPill} (farRight=${sc.starOnFarRight})`);
      if (sc.hasLegacyPill || sc.starDisplay !== 'flex' || !sc.starHasSvg || !sc.starOnFarRight || !sc.starInViewport) {
        throw new Error(`Star-only placement assertion failed: ${JSON.stringify(sc)}`);
      }

      // Capture-phase scroll listener must hide star button when textarea scrolls out of view
      const scrollStarCheck = await pageClient.send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const scroller = document.getElementById('chat-scroller');
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const star = shadow.querySelector('#pc-star-btn');
          scroller.scrollTop = 450;
          await new Promise(r => setTimeout(r, 250));
          const starScrolledOut = star.style.display;
          scroller.scrollTop = 0;
          await new Promise(r => setTimeout(r, 250));
          const starScrolledBack = star.style.display;
          return { starScrolledOut, starScrolledBack };
        })()`
      });
      const ssc = scrollStarCheck.result.value;
      if (ssc.starScrolledOut !== 'none' || ssc.starScrolledBack !== 'flex') {
        throw new Error(`Floating star button did not hide/restore on container scroll: ${JSON.stringify(ssc)}`);
      }
      console.log('✓ Floating star button hides when target scrolls offscreen and returns on scroll back');

      // Star button must follow the chat box, never a credential field.
      const sensitiveCheck = await pageClient.send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const out = {};
          for (const id of ['login-password', 'login-token']) {
            document.getElementById(id).focus();
            await new Promise(r => setTimeout(r, 300));
            const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
            out[id] = {
              star: shadow.querySelector('#pc-star-btn').style.display
            };
          }
          document.getElementById('prompt-textarea').focus();
          await new Promise(r => setTimeout(r, 400));
          return out;
        })()`
      });
      console.log('✓ Star button display after focusing sensitive fields:', sensitiveCheck.result.value);
      for (const [id, st] of Object.entries(sensitiveCheck.result.value)) {
        if (st.star !== 'none') throw new Error(`Star button stayed visible on sensitive field #${id}: ${JSON.stringify(st)}`);
      }

      // Clicking star when the draft is empty gives friendly feedback without opening the modal
      const emptyStarRes = await evalInIsolated(`(async () => {
        const ta = document.getElementById('prompt-textarea');
        const prev = ta.value;
        ta.value = '   ';
        const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
        shadow.querySelector('#pc-star-btn').click();
        await new Promise(r => setTimeout(r, 150));
        const modalOpen = shadow.querySelector('.pc-backdrop').classList.contains('is-open');
        const toastText = shadow.querySelector('#pc-toast').textContent.trim();
        ta.value = prev;
        ta.focus();
        await new Promise(r => setTimeout(r, 150));
        return { modalOpen, toastText };
      })()`, true);
      if (emptyStarRes.result.value.modalOpen || !/Type a prompt/i.test(emptyStarRes.result.value.toastText)) {
        throw new Error(`Empty-draft star click behaved unexpectedly: ${JSON.stringify(emptyStarRes.result.value)}`);
      }
      console.log('✓ Clicking star button with empty draft prompts cleanly without opening modal');

      // Open the modal via OPEN_OPTIMIZER_MODAL command (Alt+O / Context menu path)
      console.log('→ Opening optimizer modal via OPEN_OPTIMIZER_MODAL command...');
      await openModalViaSwCommand('/chat');
      await sleep(400);

      // Verify modal opened and pre-filled with textarea value
      const modalCheck = await evalInIsolated(`
        (() => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const backdrop = shadow.querySelector('.pc-backdrop');
          const rawInput = shadow.querySelector('#pc-raw-input');
          const root = shadow.querySelector('.pc-root');
          const cs = getComputedStyle(root);
          return {
            isOpen: backdrop.classList.contains('is-open'),
            prefilled: rawInput.value,
            theme: root.getAttribute('data-theme'),
            accent: cs.getPropertyValue('--accent').trim()
          };
        })()
      `);
      console.log(`✓ In-Page Modal Opened: active=${modalCheck.result.value.isOpen}, prefilled="${modalCheck.result.value.prefilled}"`);

      // The modal header carries the logo (loaded through the web-accessible resource).
      const modalLogo = await evalInIsolated(`
        (() => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const img = shadow.querySelector('.pc-modal__logo');
          return {
            present: Boolean(img),
            loaded: Boolean(img && img.complete && img.naturalWidth > 0),
            title: shadow.querySelector('#pc-modal-title')?.textContent.trim(),
            sub: shadow.querySelector('.pc-modal__subtitle')?.textContent.trim()
          };
        })()
      `);
      console.log('✓ In-page modal brand:', modalLogo.result.value);

      console.log('→ Checking every engine is visible in the in-page engine picker...');
      for (const height of [900, 560]) {
        await pageClient.send('Emulation.setDeviceMetricsOverride', { width: 1280, height, deviceScaleFactor: 1, mobile: false });
        await sleep(250);
        const v = (await evalInIsolated(engineMenuVisibility("document.getElementById('promptcraft-root-host').shadowRoot", '#pc-engine-slot'), true)).result.value;
        if (v.error || v.visible.length !== v.total || v.total !== 7 || !v.visible.includes('omniroute')) {
          throw new Error(`In-page engine picker at ${height}px hides engines or missing omniroute: ${JSON.stringify(v)}`);
        }
      }
      await pageClient.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      console.log('✓ In-page engine picker shows all engines at 900px and 560px tall');

      console.log('→ Checking Ask me first, page context and saved prompts in the in-page panel...');
      const ipAssist = (await evalInIsolated(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(100); } return null; };
        const root = document.getElementById('promptcraft-root-host').shadowRoot;
        const $ = sel => root.querySelector(sel);
        const out = {};
        $('#pc-ask-btn').click();
        const sheet = await until(() => { const f = $('.pc-clarify'); return f && !f.hidden && f; });
        out.questions = sheet ? sheet.querySelectorAll('.pc-clarify__q').length : 0;
        sheet?.querySelector('[data-act="cancel"]').click();
        await wait(100);
        out.sheetClosed = $('.pc-clarify').hidden;

        const toggle = $('#pc-context-toggle');
        toggle.click();
        await wait(500);
        out.contextSaved = (await chrome.storage.local.get('promptcraft_settings')).promptcraft_settings.includePageContext;
        toggle.click();
        await wait(500);
        out.contextCleared = (await chrome.storage.local.get('promptcraft_settings')).promptcraft_settings.includePageContext;

        $('#pc-library-btn').click();
        const items = await until(() => root.querySelectorAll('.pc-libpick__item').length && root.querySelectorAll('.pc-libpick__item'));
        out.libraryItems = items ? items.length : 0;
        $('.pc-libpick [data-act="close"]').click();
        await wait(100);
        out.libraryClosed = $('.pc-libpick').hidden;
        return out;
      })()`, true)).result.value;
      console.log('  in-page assist:', JSON.stringify(ipAssist));
      if (ipAssist.questions !== 3 || !ipAssist.sheetClosed) throw new Error('In-page Ask me first failed: ' + JSON.stringify(ipAssist));
      if (ipAssist.contextSaved !== true || ipAssist.contextCleared !== false) throw new Error('Page context switch did not persist through the worker: ' + JSON.stringify(ipAssist));
      if (!(ipAssist.libraryItems >= 1) || !ipAssist.libraryClosed) throw new Error('In-page saved prompts failed: ' + JSON.stringify(ipAssist));
      console.log('✓ In-page: Ask me first, page context and saved prompts behave');
      if (!modalLogo.result.value.loaded) throw new Error('In-page modal logo did not load (is assets/logo.png web-accessible?)');
      if (modalLogo.result.value.title !== 'PromptOptimizer') throw new Error('In-page modal title is wrong: ' + modalLogo.result.value.title);

      // Switch to the newly created "Security Auditor" custom framework tab
      console.log('→ Switching to custom "Security Auditor" tab in the in-page modal...');
      const tabSwitched = await evalInIsolated(`
        (() => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const customTab = Array.from(shadow.querySelectorAll('.pc-segmented__item')).find(t => t.textContent.includes('Security Auditor'));
          if (!customTab) return { found: false };
          customTab.click();
          return {
            found: true,
            name: customTab.textContent.trim(),
            selected: customTab.getAttribute('aria-selected'),
            tabindex: customTab.getAttribute('tabindex'),
            status: shadow.querySelector('#pc-footer-status')?.textContent || '',
            autoOptimized: !shadow.querySelector('#pc-result-text')?.hidden
          };
        })()
      `);
      console.log('✓ In-Page Tab Switch:', tabSwitched.result.value);
      const tsv = tabSwitched.result.value;
      if (!tsv.found || tsv.selected !== 'true' || tsv.tabindex !== '0' || tsv.autoOptimized) {
        throw new Error(`In-page tab switch assertion failed: ${JSON.stringify(tsv)}`);
      }

      // In-page design picker: the modal header carries the same compact menu.
      console.log('→ Testing the design picker in the In-Page Modal...');
      const inPageThemeRes = await evalInIsolated(`
        (async () => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const root = shadow.querySelector('.pc-root');
          const slot = shadow.querySelector('#pc-theme-slot .pc-select');
          if (!slot) return { error: 'Design picker not mounted in shadow DOM' };
          const before = root.getAttribute('data-theme');
          slot.querySelector('.pc-select__trigger').click();
          await new Promise(r => setTimeout(r, 80));
          slot.querySelector('.pc-select__option[data-value="manuscript"]').click();
          await new Promise(r => setTimeout(r, 200));
          const cs = getComputedStyle(root);
          return {
            before,
            after: root.getAttribute('data-theme'),
            accent: cs.getPropertyValue('--accent').trim(),
            font: cs.getPropertyValue('--font-sans').trim().slice(0, 24),
            options: slot.querySelectorAll('.pc-select__option').length
          };
        })()
      `, true);
      console.log('✓ In-Page Modal design picker:', inPageThemeRes.result.value);
      const ip = inPageThemeRes.result.value;
      if (ip.error) throw new Error(`In-page design picker missing: ${JSON.stringify(ip)}`);
      if (ip.options !== DESIGN_COUNT) throw new Error(`In-page picker should list ${DESIGN_COUNT} designs, found ${ip.options}`);
      if (ip.after !== 'manuscript' || ip.accent.toUpperCase() !== '#8C2F2B') {
        throw new Error(`In-page design did not apply: ${JSON.stringify(ip)}`);
      }
      const persistedInPage = await evalInIsolated(`
        new Promise(r => setTimeout(() =>
          chrome.storage.local.get('promptcraft_settings', x => r(x.promptcraft_settings.theme)), 400))
      `, true);
      if (persistedInPage.result.value !== 'manuscript') {
        throw new Error('In-page design pick was not persisted through the worker: ' + persistedInPage.result.value);
      }
      console.log('✓ In-page design pick persisted through the service worker');

      // Click Optimize with the offline engine
      console.log('→ Clicking "Optimize"...');
      const optClickRes = await evalInIsolated(`
        (() => {
          try {
            const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
            const engine = shadow.querySelector('#pc-engine-slot .pc-select');
            engine.querySelector('.pc-select__trigger').click();
            engine.querySelector('.pc-select__option[data-value="offline"]').click();
            const btn = shadow.querySelector('#pc-optimize-btn');
            const inputVal = shadow.querySelector('#pc-raw-input').value;
            btn.click();
            return { inputVal, engine: engine.dataset.value, btnDisabled: btn.disabled, btnText: btn.textContent.trim() };
          } catch(e) {
            return { error: e.message, stack: e.stack };
          }
        })()
      `);
      console.log('→ Click diagnostic:', optClickRes.result.value);

      /* Wait until the run settles, then assert on the outcome.
         A failed optimization writes its message into #pc-placeholder and leaves
         #pc-result-text empty, so "0 chars" is ambiguous — it means either "still
         running" or "threw an error". Previously this logged a ✓ unconditionally
         and let the failure surface two steps later as a confusing textarea
         mismatch. Wait for a terminal state, report which one, and fail here. */
      let shadowResult = '';
      let lastState = null;
      for (let w = 0; w < 40; w++) {
        await sleep(250);
        const checkRes = await evalInIsolated(`
          (() => {
            const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
            const resText = shadow.querySelector('#pc-result-text')?.textContent || '';
            const placeholder = shadow.querySelector('#pc-placeholder')?.textContent || '';
            const status = shadow.querySelector('#pc-footer-status')?.textContent || '';
            const busy = Boolean(shadow.querySelector('#pc-optimize-btn')?.disabled);
            return { resText, placeholder, status, busy };
          })()
        `);
        lastState = checkRes.result.value;
        if (lastState?.resText && lastState.resText.length > 50) {
          shadowResult = lastState.resText;
          break;
        }
        // Settled with no result => it failed. Stop early and report the reason.
        if (lastState && !lastState.busy && /failed|error/i.test(lastState.status || '')) break;
      }
      if (shadowResult) {
        console.log(`✓ Result generated in in-page modal (${shadowResult.length} chars)`);
      } else {
        /* Distinguish "the round-trip hangs" from "the round-trip failed".
           A Manifest V3 worker is evicted after ~30s idle, and this step runs
           minutes into the suite, so a hang here usually means the worker was
           not woken to answer. Ask Chrome directly which case we are in. */
        let swAlive = null;
        try {
          const listRes = await cdpFetch('/json/list');
          const targets = await listRes.json();
          swAlive = targets.some(t => String(t.type).includes('service_worker'));
        } catch (err) {
          swAlive = `probe failed: ${err.message}`;
        }
        console.log('✗ In-page optimization produced no result.');
        console.log('  Final in-page state:', lastState);
        console.log('  Service worker target present:', swAlive);
        throw new Error(
          'In-page modal produced no output. ' +
          `status=${JSON.stringify(lastState?.status)} busy=${lastState?.busy} ` +
          `swTarget=${swAlive} ` +
          `placeholder=${JSON.stringify((lastState?.placeholder || '').slice(0, 300))}`
        );
      }

      // Test in-page inline output editing, Undo revert, and custom refine bar state
      console.log('→ Testing In-Page Modal inline editing and Undo...');
      const inPageEditUndo = await evalInIsolated(`
        (async () => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const resEl = shadow.querySelector('#pc-result-text');
          const orig = resEl.textContent;
          const customForm = shadow.querySelector('.pc-assist__custom');
          const customHiddenForOffline = customForm ? customForm.hidden : false;
          const ce = resEl.getAttribute('contenteditable');
          resEl.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'x' }));
          resEl.textContent = 'Inline shadow DOM manual edit';
          resEl.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 150));
          const editedStatus = shadow.querySelector('#pc-footer-status')?.textContent || '';
          const undoBtn = shadow.querySelector('[data-act="undo"]');
          const undoVisible = Boolean(undoBtn) && !undoBtn.hidden;
          undoBtn?.click();
          await new Promise(r => setTimeout(r, 150));
          return {
            customExists: Boolean(customForm),
            customHiddenForOffline,
            ce,
            editedStatus,
            undoVisible,
            revertedMatchesOrig: resEl.textContent === orig,
            revertedStatus: shadow.querySelector('#pc-footer-status')?.textContent || ''
          };
        })()
      `, true);
      const ipe = inPageEditUndo.result.value;
      if (
        !ipe.customExists ||
        !ipe.customHiddenForOffline ||
        ipe.ce !== 'plaintext-only' ||
        ipe.editedStatus !== 'Edited' ||
        !ipe.undoVisible ||
        !ipe.revertedMatchesOrig ||
        ipe.revertedStatus !== 'Reverted change'
      ) {
        throw new Error(`In-page inline edit / Undo failed: ${JSON.stringify(ipe)}`);
      }
      console.log('✓ In-page modal inline editing and Undo revert verified');

      // Save the in-page result to the library; it goes through the service worker.
      console.log('→ Testing Save to library from the In-Page Modal...');
      const inPageSave = await evalInIsolated(`
        (async () => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const wait = ms => new Promise(r => setTimeout(r, ms));
          shadow.querySelector('#pc-save-btn').click();
          await wait(500);
          const form = shadow.querySelector('#pc-save-slot form');
          if (!form || form.hidden) return { error: 'in-page save sheet did not open' };
          const chips = [...form.querySelectorAll('.pc-labelchip')].map(c => c.dataset.label);
          shadow.querySelector('#pc-save-title').value = 'REST API in Go';
          shadow.querySelector('#pc-save-labels').value = 'backend';
          form.requestSubmit();
          await wait(700);
          const stored = await new Promise(r =>
            chrome.storage.local.get('promptcraft_library', x => r(x.promptcraft_library || [])));
          return {
            chips,
            closed: form.hidden,
            titles: stored.map(e => e.title),
            labels: stored.find(e => e.title === 'REST API in Go')?.labels,
            original: stored.find(e => e.title === 'REST API in Go')?.original
          };
        })()
      `, true);
      const ips = inPageSave.result.value;
      console.log('✓ In-page save result:', ips);
      if (ips.error) throw new Error(ips.error);
      if (!ips.chips.includes('code')) throw new Error('In-page sheet did not offer existing labels: ' + JSON.stringify(ips.chips));
      if (!ips.closed || !ips.titles.includes('REST API in Go') || !ips.titles.includes('CSV parser script')) {
        throw new Error('In-page save did not land in the library: ' + JSON.stringify(ips));
      }
      if (JSON.stringify(ips.labels) !== JSON.stringify(['backend']) || ips.original !== 'build a rest api in go') {
        throw new Error('In-page save lost its labels or original draft: ' + JSON.stringify(ips));
      }

      // The modal's output box must show the whole result too, not stop at a fixed height.
      await pageClient.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const modalLayout = await evalInIsolated(`
        (async () => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const out = shadow.querySelector('#pc-result-text');
          const keep = out.textContent;
          out.textContent = Array.from({ length: 60 }, (_, i) => 'Line ' + (i + 1) + ' of a long optimized prompt that keeps going.').join('\\n');
          await new Promise(r => setTimeout(r, 200));
          const body = shadow.querySelector('.pc-modal__body');
          body.scrollTop = body.scrollHeight;
          const boxEl = shadow.querySelector('.pc-modal__outbox');
          const box = boxEl.getBoundingClientRect();
          const text = out.getBoundingClientRect();
          const foot = shadow.querySelector('.pc-modal__footer').getBoundingClientRect();
          const result = {
            boxHeight: Math.round(box.height),
            textHeight: Math.round(text.height),
            gapToFooter: Math.round(foot.top - box.bottom),
            boxScrollsInside: boxEl.scrollHeight > boxEl.clientHeight + 1,
            footerInView: foot.bottom <= innerHeight + 1
          };
          out.textContent = keep;
          return result;
        })()
      `, true);
      const ml = modalLayout.result.value;
      console.log('  in-page modal layout:', ml);
      if (ml.gapToFooter < 0) throw new Error('In-page output box overlaps the footer: ' + JSON.stringify(ml));
      if (ml.boxScrollsInside) throw new Error('In-page output box has an inner scrollbar: ' + JSON.stringify(ml));
      if (ml.boxHeight < ml.textHeight) throw new Error('In-page box is shorter than its text: ' + JSON.stringify(ml));
      if (ml.boxHeight <= 240) throw new Error('In-page output box is still capped at its old 240px: ' + JSON.stringify(ml));
      if (!ml.footerInView) throw new Error('In-page footer (Save / Copy / Insert) is out of reach: ' + JSON.stringify(ml));
      console.log('✓ The in-page output box shows the whole result and runs down to the footer');

      // Click "Insert into Chat"
      console.log('→ Clicking "Insert into Chat"...');
      const clickRes = await evalInIsolated(`
        (() => {
          try {
            const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
            const btn = shadow.querySelector('#pc-insert-btn');
            btn.click();
            return { clicked: true };
          } catch(e) {
            return { error: e.message };
          }
        })()
      `);
      console.log('→ Insert click return:', clickRes.result.value);
      await sleep(500);

      // Verify that the host page's textarea now contains the custom elevated prompt!
      const finalTaCheck = await pageClient.send('Runtime.evaluate', {
        expression: 'document.getElementById("prompt-textarea").value'
      });
      const finalVal = finalTaCheck.result.value || '';
      if (finalVal.includes('SECURITY REVIEW AUDIT') && finalVal.includes('build a rest api in go')) {
        console.log('✓ Successfully replaced chat textarea with the custom elevated prompt!');
        console.log('  New textarea preview:\n  ' + finalVal.split('\n').slice(0, 4).join('\n  '));
      } else {
        throw new Error('Chat textarea was not updated with custom prompt. Value: ' + finalVal);
      }

      // Test far-right Star button quick auto-enhance in-place using preconfigured settings + Undo toast
      console.log('→ Testing far-right Star button auto-enhance with preconfigured setup and Undo...');
      const quickStarRes = await evalInIsolated(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(100); } return null; };
        const stored = await chrome.storage.local.get('promptcraft_settings');
        await chrome.storage.local.set({
          promptcraft_settings: { ...stored.promptcraft_settings, preferredEngine: 'offline', preferredFramework: 'rtf' }
        });

        const ta = document.getElementById('prompt-textarea');
        const originalDraft = 'plan a weekend hiking trip';
        ta.value = originalDraft;
        ta.focus();
        await wait(200);

        const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
        const star = shadow.querySelector('#pc-star-btn');
        star.click();

        const replaced = await until(() => ta.value !== originalDraft && ta.value.includes(originalDraft));
        const modalWasOpened = shadow.querySelector('.pc-backdrop').classList.contains('is-open');
        const enhancedValue = ta.value;
        const toastEl = shadow.querySelector('#pc-toast');
        const undoBtn = shadow.querySelector('.pc-toast__action');
        const toastShown = toastEl.classList.contains('is-visible') && Boolean(undoBtn);
        const toastText = toastEl.textContent.trim();

        undoBtn?.click();
        await wait(150);
        const restoredValue = ta.value;

        return { replaced: Boolean(replaced), modalWasOpened, enhancedValue, toastShown, toastText, restoredValue, originalDraft };
      })()`, true);
      const qsr = quickStarRes.result.value;
      if (
        !qsr.replaced ||
        qsr.modalWasOpened ||
        !/### ROLE/.test(qsr.enhancedValue) ||
        !qsr.toastShown ||
        qsr.restoredValue !== qsr.originalDraft
      ) {
        throw new Error(`Star quick-enhance / Undo check failed: ${JSON.stringify(qsr)}`);
      }
      console.log(`✓ Star button auto-enhanced draft in-place via preconfigured RTF+offline without opening modal, then Undo restored original`);

      // Test composer-shell anchoring (clears internal Send button, skips hidden backing textarea, enhances contenteditable)
      console.log('→ Testing content script composer-shell anchoring and contenteditable quick enhance on /composer...');
      isolatedContextId = null;
      await pageClient.send('Page.navigate', { url: 'http://127.0.0.1:8765/composer' });
      for (let i = 0; i < 30 && !isolatedContextId; i++) await sleep(100);
      await sleep(500);
      const ceCheck = await evalInIsolated(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(100); } return null; };
        const ce = document.getElementById('ce-input');
        ce.textContent = 'draft a launch announcement';
        await wait(250);

        const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
        const star = shadow.querySelector('#pc-star-btn');
        await until(() => star.style.display === 'flex');
        const sRect = star.getBoundingClientRect();
        const sendRect = document.getElementById('send-btn').getBoundingClientRect();
        const shellRect = document.getElementById('composer-shell').getBoundingClientRect();

        star.click();
        const updated = await until(() => (ce.innerText || ce.textContent).includes('ROLE') && (ce.innerText || ce.textContent).includes('draft a launch announcement'));
        const afterText = ce.innerText || ce.textContent;
        shadow.querySelector('.pc-toast__action')?.click();
        await wait(150);
        const undoneText = (ce.innerText || ce.textContent).trim();

        return {
          starDisplay: star.style.display,
          clearsComposerRightEdge: sRect.left >= shellRect.right - 2,
          clearsSendButton: sRect.left >= sendRect.right,
          updated: Boolean(updated),
          afterLen: afterText.length,
          undoneText
        };
      })()`, true);
      const cec = ceCheck.result.value;
      if (
        cec.starDisplay !== 'flex' ||
        !cec.clearsComposerRightEdge ||
        !cec.clearsSendButton ||
        !cec.updated ||
        cec.undoneText !== 'draft a launch announcement'
      ) {
        throw new Error(`Composer-shell / contenteditable quick-enhance failed: ${JSON.stringify(cec)}`);
      }
      console.log('✓ Composer anchor skipped hidden textarea, cleared Send button on far right, and enhanced/undid contenteditable draft');

      // Submit auto-reset on /composer: enhance then click Send clearing composer resets star button to idle
      const ceSubmitReset = await evalInIsolated(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(60); } return null; };
        const ce = document.getElementById('ce-input');
        const sendBtn = document.getElementById('send-btn');
        const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
        const star = shadow.querySelector('#pc-star-btn');
        ce.textContent = 'submit reset check';
        ce.focus();
        await wait(150);
        star.click();
        const becameEnhanced = await until(() => star.dataset.state === 'enhanced');
        ce.textContent = '';
        sendBtn.click();
        const resetIdle = await until(() => star.dataset.state === 'idle' && !star.classList.contains('is-revert'), 2000);
        return { becameEnhanced: Boolean(becameEnhanced), resetIdle: Boolean(resetIdle), finalState: star.dataset.state };
      })()`, true);
      const csr = ceSubmitReset.result.value;
      if (!csr.becameEnhanced || !csr.resetIdle || csr.finalState !== 'idle') {
        throw new Error(`Submit auto-reset check failed: ${JSON.stringify(csr)}`);
      }
      console.log('✓ Send click clearing composer automatically resets star button back to idle');

      // Test Gemini Quill rich-editor behavior (/gemini): multi-line repair->enhance, no paste event, NBSP survival, revert fidelity, layout shift, narrow viewport button clearance, and submit reset
      console.log('→ Testing Gemini Quill composer fixture (/gemini)...');
      isolatedContextId = null;
      await pageClient.send('Page.navigate', { url: 'http://127.0.0.1:8765/gemini' });
      for (let i = 0; i < 40 && !isolatedContextId; i++) await sleep(100);
      await sleep(500);

      const geminiRes = await evalInIsolated(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(50); } return null; };
        const stored = await chrome.storage.local.get('promptcraft_settings');
        const baseSettings = stored.promptcraft_settings || {};
        await chrome.storage.local.set({
          promptcraft_settings: {
            ...baseSettings,
            preferredEngine: 'omniroute',
            omnirouteEnabled: true,
            omnirouteBaseUrl: 'http://127.0.0.1:8765/v1',
            preferredFramework: 'rtf',
            quickRepairEnabled: true,
            enableFloatingWidget: true
          }
        });
        await wait(250);

        const shadow = await until(() => document.getElementById('promptcraft-root-host')?.shadowRoot);
        const star = await until(() => shadow.querySelector('#pc-star-btn'));
        const legacyPill = shadow.querySelector('#pc-trigger, .pc-trigger-pill');
        await until(() => star.style.display === 'flex');

        const ql = document.getElementById('ql');
        const sendBtn = document.getElementById('gemini-send');
        const micBtn = document.getElementById('gemini-mic');

        const rectOverlap = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

        const starInitialRect = star.getBoundingClientRect();
        const clearsButtonsInitially =
          !rectOverlap(starInitialRect, sendBtn.getBoundingClientRect()) &&
          !rectOverlap(starInitialRect, micBtn.getBoundingClientRect());

        // Populate multi-line draft with blank <p><br></p> paragraph and double space
        const mkP = txt => {
          const p = document.createElement('p');
          if (txt) p.textContent = txt;
          else p.appendChild(document.createElement('br'));
          return p;
        };
        ql.replaceChildren(mkP('helo  gemni'), mkP(''), mkP('pls expln async'));
        ql.focus();
        await wait(150);

        star.click();
        const enhancedOk = await until(() => star.dataset.state === 'enhanced' && ql.textContent.includes('Explain event loop'));
        await wait(100);
        const enhancedPs = Array.from(ql.querySelectorAll('p')).map(p => p.textContent);
        const enhancedBlankClass = ql.classList.contains('ql-blank');
        const sendEnabledWhenEnhanced = !sendBtn.disabled;

        // Revert via in-button click and check exact multi-line restoration
        star.click();
        const revertedOk = await until(() => star.dataset.state === 'idle');
        await wait(120);
        const revertedParagraphs = Array.from(ql.querySelectorAll('p')).map(p => (p.textContent || '').replace(/\\u00a0/g, ' '));

        // Layout shift without resize: star must move down with composer
        const beforeShiftTop = star.getBoundingClientRect().top;
        const composer = document.getElementById('gemini-composer');
        composer.style.display = 'block';
        composer.style.marginTop = '180px';
        await wait(450);
        const afterShiftTop = star.getBoundingClientRect().top;

        // Submit auto-reset: enhance then click Send clearing back to <p><br></p>
        star.click();
        await until(() => star.dataset.state === 'enhanced');
        sendBtn.click();
        const resetAfterSubmit = await until(() => star.dataset.state === 'idle' && ql.classList.contains('ql-blank'), 2500);

        return {
          hasLegacyPill: Boolean(legacyPill),
          clearsButtonsInitially,
          enhancedOk: Boolean(enhancedOk),
          enhancedPs,
          enhancedBlankClass,
          sendEnabledWhenEnhanced,
          revertedOk: Boolean(revertedOk),
          revertedParagraphs,
          shiftDeltaTop: Math.round(afterShiftTop - beforeShiftTop),
          resetAfterSubmit: Boolean(resetAfterSubmit)
        };
      })()`, true);

      const pasteEventsCount = (await pageClient.send('Runtime.evaluate', {
        expression: 'window.__pasteEvents',
        returnByValue: true
      })).result.value;

      // Also test narrow viewport (Split / Canvas width) on /gemini to ensure star clears Send and Mic
      await pageClient.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      const narrowCheck = await evalInIsolated(`
        (() => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const star = shadow.querySelector('#pc-star-btn');
          const s = star.getBoundingClientRect();
          const send = document.getElementById('gemini-send').getBoundingClientRect();
          const mic = document.getElementById('gemini-mic').getBoundingClientRect();
          const rectOverlap = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
          return {
            display: star.style.display,
            inViewport: s.left >= 0 && s.top >= 0 && s.right <= window.innerWidth && s.bottom <= window.innerHeight,
            overlapsSend: rectOverlap(s, send),
            overlapsMic: rectOverlap(s, mic)
          };
        })()
      `);
      await pageClient.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(200);

      const gr = geminiRes.result.value;
      const nc = narrowCheck.result.value;
      if (
        gr.hasLegacyPill ||
        !gr.clearsButtonsInitially ||
        !gr.enhancedOk ||
        gr.enhancedBlankClass ||
        !gr.sendEnabledWhenEnhanced ||
        JSON.stringify(gr.enhancedPs) !== JSON.stringify(['### ROLE', 'Senior engineer', '', '### TASK', '1. Explain event loop', '2. Compare promises']) ||
        !gr.revertedOk ||
        JSON.stringify(gr.revertedParagraphs) !== JSON.stringify(['helo  gemni', '', 'pls expln async']) ||
        Math.abs(gr.shiftDeltaTop - 180) > 10 ||
        !gr.resetAfterSubmit ||
        pasteEventsCount !== 0 ||
        nc.display !== 'flex' ||
        !nc.inViewport ||
        nc.overlapsSend ||
        nc.overlapsMic
      ) {
        throw new Error(`Gemini Quill composer check failed: ${JSON.stringify({ gr, pasteEventsCount, nc })}`);
      }
      console.log('✓ Gemini Quill fixture verified: multi-line repair->enhance (0 paste events, NBSP safe), exact <p> revert, layout-shift tracking, narrow-viewport button clearance, and submit reset');

      // Navigate back to /chat and test full two-stage Repair -> Enhance, Alt+Click, in-button Revert, Cancel & Guards
      console.log('→ Testing two-stage Repair -> Enhance pipeline, Alt+Click, in-button Revert, mid-flight Cancel & Snapshot Guards...');
      isolatedContextId = null;
      await pageClient.send('Page.navigate', { url: 'http://127.0.0.1:8765/chat' });
      for (let i = 0; i < 50 && !isolatedContextId; i++) await sleep(100);
      await sleep(500);

      const twoStageRes = await evalInIsolated(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(40); } return null; };
        const stored = await chrome.storage.local.get('promptcraft_settings');
        const baseSettings = stored.promptcraft_settings || {};
        await chrome.storage.local.set({
          promptcraft_settings: {
            ...baseSettings,
            preferredEngine: 'omniroute',
            omnirouteEnabled: true,
            omnirouteBaseUrl: 'http://127.0.0.1:8765/v1',
            preferredFramework: 'rtf',
            quickRepairEnabled: true,
            enableFloatingWidget: true
          }
        });
        await wait(250);

        const ta = document.getElementById('prompt-textarea');
        const shadow = await until(() => document.getElementById('promptcraft-root-host')?.shadowRoot);
        const star = await until(() => shadow.querySelector('#pc-star-btn'));
        const toastEl = shadow.querySelector('#pc-toast');
        ta.focus();
        await wait(200);

        // 1. Two-stage Repair -> Enhance + In-Button Revert (enhanced -> idle)
        const typoDraft = 'wrte a tst for lgoin';
        ta.value = typoDraft;
        star.click();
        const enhancedDone = await until(() => star.dataset.state === 'enhanced' && ta.value === 'ENHANCED_MOCK: write a test for login');
        const enhancedState = {
          state: star.dataset.state,
          hasRevertClass: star.classList.contains('is-revert'),
          hasSvg: Boolean(star.querySelector('svg')),
          toastUndo: Boolean(shadow.querySelector('.pc-toast__action')),
          value: ta.value
        };
        star.click(); // In-button ↩ revert
        const revertedIdle = await until(() => star.dataset.state === 'idle');
        const afterButtonRevert = {
          revertedIdle: Boolean(revertedIdle),
          state: star.dataset.state,
          hasRevertClass: star.classList.contains('is-revert'),
          value: ta.value
        };

        // 2. Alt+Click Repair-Only + In-Button Revert (repaired -> idle)
        ta.value = typoDraft;
        star.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
        const repairOnlyDone = await until(() => star.dataset.state === 'repaired' && ta.value === 'write a test for login');
        const repairOnlyState = {
          done: Boolean(repairOnlyDone),
          state: star.dataset.state,
          hasRevertClass: star.classList.contains('is-revert'),
          hasSvg: Boolean(star.querySelector('svg')),
          toastText: toastEl.textContent.trim(),
          value: ta.value
        };
        star.click(); // In-button ↩ revert
        await until(() => star.dataset.state === 'idle');
        const repairOnlyReverted = ta.value;

        // 3. Fast Step 1 + Slow Step 2 -> Mid-flight Cancel keeps Step 1 repair in repaired (↩) state -> Revert
        const slowStep2Orig = '__SLOW_STEP2__ helo wrld';
        ta.value = slowStep2Orig;
        star.click();
        const reachedStep2Busy = await until(() =>
          star.dataset.state === 'enhancing' &&
          star.classList.contains('is-busy') &&
          Boolean(star.querySelector('.pc-spinner')) &&
          ta.value === '__SLOW_STEP2__ hello world'
        );
        const valueAtStep2Busy = ta.value;
        star.click(); // Cancel Step 2 in flight
        const cancelledKeptRepair = await until(() => star.dataset.state === 'repaired' && !star.classList.contains('is-busy'));
        const midCancelToast = toastEl.textContent.trim();
        await wait(150);
        const valueAfterStep2Cancel = ta.value;
        star.click(); // Revert Step 1 back to original
        await until(() => star.dataset.state === 'idle');
        await wait(200);
        const valueAfterStep1Revert = ta.value;

        // 4. Slow Step 1 Cancel -> resets directly to idle without overwrite
        const slowStep1Orig = '__SLOW_STEP1__ draft';
        ta.value = slowStep1Orig;
        star.click();
        const reachedStep1Busy = await until(() => star.dataset.state === 'repairing' && star.classList.contains('is-busy'));
        star.click();
        const step1CancelIdle = await until(() => star.dataset.state === 'idle' && !star.classList.contains('is-busy'));
        const step1CancelVal = ta.value;

        // 5. Mid-flight composer edit snapshot guard aborts Step 2 overwrite
        await chrome.storage.local.set({
          promptcraft_settings: { ...baseSettings, preferredEngine: 'omniroute', omnirouteEnabled: true, omnirouteBaseUrl: 'http://127.0.0.1:8765/v1', quickRepairEnabled: false, enableFloatingWidget: true }
        });
        await wait(120);
        ta.value = '__SLOW_EDIT__ base prompt';
        star.click();
        await until(() => star.dataset.state === 'enhancing' && star.classList.contains('is-busy'));
        await wait(50);
        ta.value = '__SLOW_EDIT__ base prompt + user typed';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const snapshotAbortedIdle = await until(() => star.dataset.state === 'idle' && /kept your edit/i.test(toastEl.textContent));
        const snapshotPreservedValue = ta.value;

        // 6. > 8000 char refusal + Clear-composer auto-reset
        await chrome.storage.local.set({
          promptcraft_settings: { ...baseSettings, preferredEngine: 'omniroute', omnirouteEnabled: true, omnirouteBaseUrl: 'http://127.0.0.1:8765/v1', quickRepairEnabled: true, enableFloatingWidget: true }
        });
        await wait(120);
        ta.value = 'a'.repeat(8001);
        star.click();
        await wait(120);
        const overLimitState = {
          state: star.dataset.state,
          toastText: toastEl.textContent.trim(),
          len: ta.value.length
        };

        ta.value = 'reset on clear draft';
        star.click();
        const readyToClear = await until(() => star.dataset.state === 'enhanced');
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const clearedIdle = await until(() => star.dataset.state === 'idle' && !star.classList.contains('is-revert'));

        // Restore clean offline settings
        await chrome.storage.local.set({
          promptcraft_settings: { ...baseSettings, preferredEngine: 'offline', preferredFramework: 'rtf', quickRepairEnabled: true }
        });

        return {
          enhancedDone: Boolean(enhancedDone),
          enhancedState,
          afterButtonRevert,
          repairOnlyState,
          repairOnlyReverted,
          reachedStep2Busy: Boolean(reachedStep2Busy),
          valueAtStep2Busy,
          cancelledKeptRepair: Boolean(cancelledKeptRepair),
          midCancelToast,
          valueAfterStep2Cancel,
          valueAfterStep1Revert,
          slowStep2Orig,
          reachedStep1Busy: Boolean(reachedStep1Busy),
          step1CancelIdle: Boolean(step1CancelIdle),
          step1CancelVal,
          slowStep1Orig,
          snapshotAbortedIdle: Boolean(snapshotAbortedIdle),
          snapshotPreservedValue,
          overLimitState,
          readyToClear: Boolean(readyToClear),
          clearedIdle: Boolean(clearedIdle)
        };
      })()`, true);
      const tsr = twoStageRes.result.value;
      if (
        !tsr.enhancedDone ||
        tsr.enhancedState.state !== 'enhanced' ||
        !tsr.enhancedState.hasRevertClass ||
        !tsr.enhancedState.hasSvg ||
        !tsr.enhancedState.toastUndo ||
        !tsr.afterButtonRevert.revertedIdle ||
        tsr.afterButtonRevert.state !== 'idle' ||
        tsr.afterButtonRevert.hasRevertClass ||
        tsr.afterButtonRevert.value !== 'wrte a tst for lgoin'
      ) {
        throw new Error(`Two-stage Repair -> Enhance / in-button Revert failed: ${JSON.stringify(tsr)}`);
      }
      if (
        !tsr.repairOnlyState.done ||
        tsr.repairOnlyState.state !== 'repaired' ||
        !tsr.repairOnlyState.hasRevertClass ||
        !tsr.repairOnlyState.hasSvg ||
        !/Typos repaired/i.test(tsr.repairOnlyState.toastText) ||
        tsr.repairOnlyState.value !== 'write a test for login' ||
        tsr.repairOnlyReverted !== 'wrte a tst for lgoin'
      ) {
        throw new Error(`Alt+Click repair-only / revert failed: ${JSON.stringify(tsr)}`);
      }
      if (
        !tsr.reachedStep2Busy ||
        tsr.valueAtStep2Busy !== '__SLOW_STEP2__ hello world' ||
        !tsr.cancelledKeptRepair ||
        !/typo fixes kept/i.test(tsr.midCancelToast) ||
        tsr.valueAfterStep2Cancel !== '__SLOW_STEP2__ hello world' ||
        tsr.valueAfterStep1Revert !== tsr.slowStep2Orig
      ) {
        throw new Error(`Mid-flight Step 2 cancel keeping Step 1 repair failed: ${JSON.stringify(tsr)}`);
      }
      if (
        !tsr.reachedStep1Busy ||
        !tsr.step1CancelIdle ||
        tsr.step1CancelVal !== tsr.slowStep1Orig ||
        !tsr.snapshotAbortedIdle ||
        tsr.snapshotPreservedValue !== '__SLOW_EDIT__ base prompt + user typed' ||
        tsr.overLimitState.state !== 'idle' ||
        !/8001\/8000/.test(tsr.overLimitState.toastText) ||
        !tsr.readyToClear ||
        !tsr.clearedIdle
      ) {
        throw new Error(`Step 1 cancel / snapshot guard / 8000-cap / clear-reset failed: ${JSON.stringify(tsr)}`);
      }
      console.log('✓ Two-stage Repair -> Enhance, Alt+Click, in-button ↩ Revert, mid-flight Cancel, snapshot guard, 8000-char cap, and clear auto-reset verified');

      pageClient.close();

      // Scope: the same page under an unlisted hostname must get no injection.
      console.log('→ Verifying no content script runs on an unlisted origin (localhost)...');
      const otherTabRes = await cdpFetch('/json/new', { method: 'PUT' });
      const otherTab = await otherTabRes.json();
      const otherClient = await createCdpClient(otherTab.webSocketDebuggerUrl);
      await otherClient.send('Runtime.enable');
      await otherClient.send('Page.enable');
      await otherClient.send('Page.navigate', { url: 'http://localhost:8765/chat' });
      await sleep(1500);
      const otherHost = await otherClient.send('Runtime.evaluate', {
        expression: 'Boolean(document.getElementById("promptcraft-root-host"))',
        returnByValue: true
      });
      if (otherHost.result.value) {
        throw new Error('Content script ran on an origin that is not on the AI-site list.');
      }
      console.log('✓ No injection on an unlisted origin');
      otherClient.close();
    } finally {
      for (const t of pendingMockTimers) clearTimeout(t);
      pendingMockTimers.clear();
      server.close();
    }

    console.log('\n🎉 ALL 6 AUTOMATED VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    /* Tear down only the browser tree we spawned.
       `taskkill /T` on Windows and `-pid` group kill on POSIX prevent orphaned
       child processes (zygote/GPU/renderers) from lingering on the debug port. */
    const pid = browserProcess.pid;
    if (pid) {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch {}
        await sleep(350);
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
    }
    try { browserProcess.kill('SIGKILL'); } catch {}
    await sleep(1200);

    /* Chromium keeps file handles open for a moment after the process dies, so a
       single rmSync loses the race and leaks a ~12 MB profile into %TEMP% on every
       run. Retry briefly, then report rather than swallow — a silent failure here
       quietly filled the temp directory with eight orphaned profiles. */
    let removed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
        removed = !fs.existsSync(TEMP_USER_DATA);
        if (removed) break;
      } catch {}
      await sleep(700);
    }
    if (!removed) {
      console.warn(`⚠ Could not remove temp profile ${TEMP_USER_DATA} — delete it manually.`);
    }
    try { fs.rmSync(extUnderTest, { recursive: true, force: true }); } catch {}
  }
}

runTests().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
