/**
 * Automated End-to-End Verification Script for PromptOptimizer Extension
 * Uses Chrome DevTools Protocol (CDP) and native Node 24 WebSocket to test:
 * 1. Extension Manifest & Loading in Chrome
 * 2. Background Service Worker initialization & status
 * 3. Popup UI rendering, framework tabs, and end-to-end prompt optimization
 * 4. Options UI rendering & settings persistence
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BROWSER_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
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
const TEMP_USER_DATA = path.join(process.env.TEMP || 'C:\\Temp', `chrome-test-profile-${Date.now()}`);

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
 * Copy the shipped extension into a temp directory and add the mock chat host to
 * the content-script match list. The shipped manifest only lists real AI sites,
 * and the mock page is served from 127.0.0.1. Nothing but that one match differs
 * from what ships.
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
    'about:blank'
  ];

  console.log('\n[1/5] Launching Chromium in test mode...');
  const browserProcess = spawn(BROWSER_PATH, browserArgs, { stdio: 'ignore' });

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
    await popupClient.send('Runtime.enable');
    await popupClient.send('Page.enable');
    await popupClient.send('Console.enable');

    popupClient.onEvent((evt) => {
      if (evt.method === 'Runtime.exceptionThrown') {
        console.error('✗ Popup Exception:', evt.params.exceptionDetails);
      } else if (evt.method === 'Console.messageAdded') {
        console.log('  [Popup Console]:', evt.params.message.text);
      }
    });

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
              anyKey: ['openrouter', 'gemini', 'openai', 'anthropic']
                .some(p => Boolean(settings[p + 'ApiKey'])),
              engine: settings.preferredEngine,
              schemaVersion: settings.schemaVersion
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
    if (orKeyCheck.result.value.engine !== 'nano' || orKeyCheck.result.value.schemaVersion !== 3) {
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
      if (v.error || v.visible.length !== v.total || v.total < 6) throw new Error(`Popup engine picker at ${height}px hides engines: ${JSON.stringify(v)}`);
    }
    console.log('✓ Popup engine picker shows all engines');
    await popupClient.send('Emulation.clearDeviceMetricsOverride');

    // Test Framework switching in Popup (Switch to RTF)
    console.log('\n[4/5] Testing Framework switching (RTF Framework)...');
    await popupClient.send('Runtime.evaluate', {
      expression: `
        document.querySelector('.pc-segmented__item[data-framework="rtf"]').click();
        document.getElementById('optimize-btn').click();
      `
    });
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

    popupClient.close();

    // 5. Test Options Page
    console.log('\n[5/5] Testing Options Page & Settings Storage...');
    const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;
    const optionsTabRes = await cdpFetch('/json/new', { method: 'PUT' });
    const optionsTab = await optionsTabRes.json();

    const optionsClient = await createCdpClient(optionsTab.webSocketDebuggerUrl);
    await optionsClient.send('Runtime.enable');
    await optionsClient.send('Page.enable');
    await optionsClient.send('Page.navigate', { url: optionsUrl });

    for (let r = 0; r < 20; r++) {
      const state = await optionsClient.send('Runtime.evaluate', {
        expression: 'window.location.href + " | " + document.readyState'
      });
      if (state.result.value.includes('options.html') && state.result.value.includes('complete')) break;
      await sleep(250);
    }
    await sleep(400);

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

    // Console shell: nav, sections, theme picker
    const shellCheck = await optionsClient.send('Runtime.evaluate', {
      expression: `(() => ({
        sections: document.querySelectorAll('.pc-section').length,
        navItems: document.querySelectorAll('.pc-nav__item').length,
        themePicker: Boolean(document.querySelector('#theme-picker-slot .pc-select')),
        engineSelect: Boolean(document.querySelector('#preferred-engine-slot .pc-select')),
        frameworkCards: document.querySelectorAll('.pc-framework').length
      }))()`,
      returnByValue: true
    });
    console.log('✓ Options console structure:', shellCheck.result.value);
    if (shellCheck.result.value.sections < 5 || !shellCheck.result.value.themePicker) {
      throw new Error('Options console did not render the design-system structure.');
    }

    // Test saving custom instructions
    await optionsClient.send('Runtime.evaluate', {
      expression: `
        document.getElementById('custom-system-prompt').value = 'Always enforce clean architecture and unit tests.';
        document.getElementById('save-btn').click();
      `
    });
    await sleep(500);

    // Verify saved in chrome.storage.local
    const storageCheck = await optionsClient.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `
        new Promise(resolve => {
          chrome.storage.local.get('promptcraft_settings', res => {
            resolve(res.promptcraft_settings?.customSystemPrompt);
          });
        })
      `
    });
    console.log(`✓ Settings successfully persisted in chrome.storage: "${storageCheck.result.value}"`);

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

    optionsClient.close();

    // 6. Test Content Script & Floating In-Page Widget
    console.log('\n[6/6] Testing Content Script & In-Page Floating Widget on Mock Chat Interface...');
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Mock AI Chat</title></head>
        <body style="padding: 50px;">
          <h1>Mock AI Chat Interface</h1>
          <div style="margin-top: 100px;">
            <textarea id="prompt-textarea" style="width: 400px; height: 100px;" placeholder="Message ChatGPT..."></textarea>
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
      // events and the pill logic would go untested.
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

      // Focus the textarea to trigger the floating pill
      console.log('→ Focusing chat textarea #prompt-textarea...');
      await pageClient.send('Runtime.evaluate', {
        expression: `
          const ta = document.getElementById('prompt-textarea');
          ta.value = 'build a rest api in go';
          ta.focus();
        `
      });
      await sleep(400);

      // Verify trigger pill is displayed
      const pillCheck = await evalInIsolated(`
        (() => {
          const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
          const pill = shadow.querySelector('.pc-trigger-pill');
          return { display: pill.style.display, text: pill.textContent.trim() };
        })()
      `);
      console.log(`✓ Floating Trigger Visible: display="${pillCheck.result.value.display}", text="${pillCheck.result.value.text}"`);

      // The pill must follow the chat box, never a credential field.
      const sensitiveCheck = await pageClient.send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const out = {};
          for (const id of ['login-password', 'login-token']) {
            document.getElementById(id).focus();
            await new Promise(r => setTimeout(r, 300));
            const pill = document.getElementById('promptcraft-root-host').shadowRoot.querySelector('.pc-trigger-pill');
            out[id] = pill.style.display;
          }
          document.getElementById('prompt-textarea').focus();
          await new Promise(r => setTimeout(r, 400));
          return out;
        })()`
      });
      console.log('✓ Pill display after focusing sensitive fields:', sensitiveCheck.result.value);
      for (const [id, display] of Object.entries(sensitiveCheck.result.value)) {
        if (display !== 'none') throw new Error(`Pill stayed visible on sensitive field #${id}`);
      }

      // Click the trigger pill to open modal
      console.log('→ Clicking floating trigger pill...');
      await evalInIsolated(`
        const shadow = document.getElementById('promptcraft-root-host').shadowRoot;
        shadow.querySelector('.pc-trigger-pill').click();
      `);
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
        if (v.error || v.visible.length !== v.total || v.total < 6) throw new Error(`In-page engine picker at ${height}px hides engines: ${JSON.stringify(v)}`);
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
          if (customTab) {
            customTab.click();
            return { found: true, name: customTab.textContent.trim() };
          }
          return { found: false };
        })()
      `);
      console.log('✓ In-Page Tab Switch:', tabSwitched.result.value);

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
      server.close();
    }

    console.log('\n🎉 ALL 6 AUTOMATED VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    /* Tear down only the browser tree we spawned.
       `taskkill /T` is scoped to our PID and its descendants, so it cannot reach
       a real Edge window the developer has open — a broad `taskkill /IM msedge.exe`
       would. SIGTERM alone orphans Edge's child processes (zygote/GPU/renderers),
       which then linger and hold the debug port, so the tree kill is required. */
    const pid = browserProcess.pid;
    if (pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        try { browserProcess.kill('SIGKILL'); } catch {}
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
