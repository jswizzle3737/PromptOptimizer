/**
 * Background Service Worker for PromptOptimizer
 * Handles the context menu, the keyboard command, per-site opt-in, and message
 * passing from content scripts and extension pages. Nothing is kept in module
 * state: the worker is terminated after ~30s idle, so anything that must survive
 * lives in chrome.storage.
 */

import {
  optimizePrompt, refinePrompt, clarifyPrompt, setNanoBackend, CancelledError
} from '../shared/optimizer-engine.js';
import { nanoBridge } from './nano-bridge.js';
import { isEngine } from '../shared/engines.js';
import {
  DEFAULT_SETTINGS, addHistoryEntry, getSettings, saveSettings, getSites, setPendingPrompt, SITES_KEY,
  migrateTheme
} from '../shared/storage.js';
import { saveToLibrary, getLibrary, collectLabels } from '../shared/library.js';

const MENU_ID = 'promptcraft-optimize-selection';

// The Prompt API lives in documents, not workers: run Nano offscreen.
if (chrome.offscreen) setNanoBackend(nanoBridge);

const SITE_SCRIPT_PREFIX = 'promptcraft-site-';

/* ---------------------------------------------------------------------- */
/* Install / startup                                                       */
/* ---------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  // removeAll first: reloading an unpacked extension re-fires onInstalled and a
  // second create() with the same id fails with "duplicate id".
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Optimize with PromptOptimizer',
    contexts: ['selection', 'editable']
  });

  const stored = await chrome.storage.local.get('promptcraft_settings');
  if (!stored.promptcraft_settings) {
    await chrome.storage.local.set({ promptcraft_settings: DEFAULT_SETTINGS });
  } else {
    // Run the stored settings through the schema migration now, so an update
    // clears the retired credential immediately rather than on first use.
    await getSettings();
  }

  /* Deliberately NOT opening the Options page on install.
     A settings console is not a welcome — it greets a first-time user with API
     keys and chrome:// flags before they know what the tool does. First-run
     guidance lives inline in the popup, and Options is reached only when the
     user chooses an engine that needs a key. */

  // Dynamically registered scripts do not reliably survive an extension update.
  await syncSiteScripts();
});

chrome.runtime.onStartup.addListener(() => syncSiteScripts());

chrome.permissions.onRemoved.addListener(() => syncSiteScripts());

/* ---------------------------------------------------------------------- */
/* Opening the optimizer                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Open the in-page modal in `tab`.
 *
 * 1. The content script is already there (listed AI site, or an opted-in site).
 * 2. It is not: inject it now. This works on any page because both entry points
 *    (context menu, keyboard command) are user gestures that grant `activeTab`.
 * 3. The page is one extensions cannot script (chrome://, the Web Store, the PDF
 *    viewer): hand the text to the toolbar popup instead.
 */
async function openOptimizer(tab, payload) {
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_OPTIMIZER_MODAL', payload });
    return;
  } catch {
    // No receiving end yet — fall through to injection.
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
    // The content script registers its message listener synchronously and queues
    // the request until its UI has finished loading.
    await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_OPTIMIZER_MODAL', payload });
    return;
  } catch (err) {
    console.warn('PromptOptimizer cannot run on this page, using the popup instead:', err);
  }

  await openPopupWithText(payload);
}

async function openPopupWithText({ text = '', autoRun = false } = {}) {
  await setPendingPrompt({ text, autoRun });
  try {
    await chrome.action.openPopup();
  } catch {
    // The popup could not be opened programmatically. Say so instead of
    // silently dropping the request.
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'PromptOptimizer: click to optimize the text you selected' });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = (info.selectionText || '').trim();
  // With no selection the menu was opened on an editable field; the content
  // script reads that field itself.
  await openOptimizer(tab, { text, autoRun: Boolean(text), fromContextMenu: true });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-optimizer') return;
  const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  // The content script applies the "selection runs immediately" rule.
  await openOptimizer(target, { text: '', fromShortcut: true });
});

/* ---------------------------------------------------------------------- */
/* Per-site opt-in                                                         */
/* ---------------------------------------------------------------------- */

/** Reduce any URL-ish value to a bare http(s) origin, or null. */
function toOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function registerSite(origin) {
  const id = SITE_SCRIPT_PREFIX + origin;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{
    id,
    matches: [`${origin}/*`],
    js: ['content/content.js'],
    css: ['content/content.css'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  }]);
}

/**
 * Make the registered scripts match the opted-in list, and drop any opt-in whose
 * host permission the user has since revoked in chrome://extensions.
 */
async function syncSiteScripts() {
  const sites = await getSites();
  const granted = [];
  for (const origin of sites) {
    if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) granted.push(origin);
  }
  if (granted.length !== sites.length) {
    await chrome.storage.local.set({ [SITES_KEY]: granted });
  }

  const wanted = new Set(granted.map(o => SITE_SCRIPT_PREFIX + o));
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered
    .filter(s => s.id.startsWith(SITE_SCRIPT_PREFIX) && !wanted.has(s.id))
    .map(s => s.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });

  for (const origin of granted) await registerSite(origin);
}

async function enableSite(rawOrigin, tabId) {
  const origin = toOrigin(rawOrigin);
  if (!origin) throw new Error('Not a web page.');
  // The popup requests the permission inside its click handler (a user gesture
  // is required); the worker only acts on a permission that really exists.
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new Error('Permission for this site was not granted.');
  }
  const sites = await getSites();
  if (!sites.includes(origin)) await chrome.storage.local.set({ [SITES_KEY]: [...sites, origin] });
  await registerSite(origin);

  // Registration only affects pages loaded from now on; put the button on the
  // page the user is looking at as well.
  if (tabId != null) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    } catch (err) {
      console.warn('Could not inject into the current tab; it will apply on reload:', err);
    }
  }
  return origin;
}

async function disableSite(rawOrigin) {
  const origin = toOrigin(rawOrigin);
  if (!origin) throw new Error('Not a web page.');
  const sites = await getSites();
  await chrome.storage.local.set({ [SITES_KEY]: sites.filter(o => o !== origin) });
  try {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    // Required host permissions (the provider API origins) cannot be removed; the
    // opt-in is gone either way.
  }
  await syncSiteScripts();
  return origin;
}

/* ---------------------------------------------------------------------- */
/* Optimization requests                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Run one request from the popup or a page.
 * payload.action: 'optimize' (default) | 'refine' | 'clarify'.
 * `io` carries { signal, onToken, onStart } when the caller streams.
 */
async function runRequest(payload = {}, sender, io = {}) {
  const { action = 'optimize', text, frameworkId, engine, host, context, variantCount, kind, previous } = payload;
  /* The host tunes the rewrite for the target model. Prefer the sender tab's
     own URL (content script) — a popup can only claim a host, the active tab
     is what it actually shows. */
  const senderHost = (() => {
    try { return new URL(sender?.tab?.url || '').hostname; } catch { return null; }
  })();
  const common = { frameworkId, engine, host: senderHost || host, ...io };

  if (action === 'clarify') return clarifyPrompt(text, { engine, signal: io.signal });

  const result = action === 'refine'
    ? await refinePrompt(text, { ...common, kind, previous })
    : await optimizePrompt(text, { ...common, context, variantCount });

  await addHistoryEntry({
    original: text,
    optimized: result.optimized,
    engine: result.engine,
    framework: result.framework,
    degraded: result.degraded
  });
  return result;
}

/**
 * Streaming requests. The caller connects a port named 'optimize' and posts
 * { type: 'start', payload }; the worker answers with
 *   { type: 'start', engine }   an engine began (discard any streamed text)
 *   { type: 'token', delta }    streamed text
 *   { type: 'done', data } | { type: 'error', error } | { type: 'cancelled' }
 * Posting { type: 'cancel' } or disconnecting aborts the request.
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'optimize') return;
  const ctl = new AbortController();
  port.onDisconnect.addListener(() => ctl.abort());
  const post = m => { try { port.postMessage(m); } catch { /* caller closed */ } };

  port.onMessage.addListener(async msg => {
    if (msg?.type === 'cancel') { ctl.abort(); return; }
    if (msg?.type !== 'start') return;
    try {
      const data = await runRequest(msg.payload, port.sender, {
        signal: ctl.signal,
        onToken: delta => post({ type: 'token', delta }),
        onStart: engine => post({ type: 'start', engine })
      });
      post({ type: 'done', data });
    } catch (err) {
      post(err instanceof CancelledError || ctl.signal.aborted
        ? { type: 'cancelled' }
        : { type: 'error', error: err?.message || String(err) });
    }
  });
});

/* ---------------------------------------------------------------------- */
/* Message dispatcher                                                      */
/* ---------------------------------------------------------------------- */

/** Messages only extension pages may send. A content script has `sender.tab`. */
const PAGE_ONLY = new Set(['ENABLE_SITE', 'DISABLE_SITE']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (PAGE_ONLY.has(message.type) && sender.tab) {
        throw new Error('Not allowed from a web page.');
      }

      switch (message.type) {
        case 'OPTIMIZE_PROMPT': {
          // One-shot form of the 'optimize' port below, without streaming.
          const data = await runRequest({ ...message.payload, action: 'optimize' }, sender);
          sendResponse({ success: true, data });
          break;
        }

        case 'SET_THEME': {
          // The in-page panel's design picker. Normalised here, so a page cannot
          // store an arbitrary value, and written as one field.
          const saved = await saveSettings({ theme: migrateTheme(message.payload?.theme) });
          sendResponse({ success: true, theme: saved.theme });
          break;
        }

        case 'SET_VARIANTS': {
          // The in-page panel's variant-count picker. Clamped here for the same
          // reason SET_THEME normalises: a page never stores arbitrary values.
          const count = Math.max(1, Math.min(3, parseInt(message.payload?.count, 10) || 1));
          const saved = await saveSettings({ variantCount: count });
          sendResponse({ success: true, variantCount: saved.variantCount });
          break;
        }

        case 'SET_PAGE_CONTEXT': {
          // The in-page panel's "Use page context" switch: one boolean field.
          const saved = await saveSettings({ includePageContext: message.payload?.enabled === true });
          sendResponse({ success: true, includePageContext: saved.includePageContext });
          break;
        }

        case 'SET_ENGINE': {
          // The in-page panel's engine picker, persisted so the choice holds
          // everywhere (popup, panel, other pages). Rejected unless it is a
          // known engine id — a page never stores arbitrary values.
          const engineId = message.payload?.engine;
          if (!isEngine(engineId)) {
            throw new Error(`Unknown engine "${engineId}".`);
          }
          const saved = await saveSettings({ preferredEngine: engineId });
          sendResponse({ success: true, preferredEngine: saved.preferredEngine });
          break;
        }

        case 'SAVE_PROMPT': {
          // From the in-page modal, which has no direct route to the library.
          const { title, text, original, labels, framework, engine } = message.payload || {};
          const entry = await saveToLibrary({ title, text, original, labels, framework, engine });
          sendResponse({ success: true, id: entry.id });
          break;
        }

        case 'LIBRARY_LABELS':
          sendResponse({ success: true, labels: collectLabels(await getLibrary()) });
          break;

        case 'ENABLE_SITE':
          sendResponse({ success: true, origin: await enableSite(message.origin, message.tabId) });
          break;

        case 'DISABLE_SITE':
          sendResponse({ success: true, origin: await disableSite(message.origin) });
          break;

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error('Service worker error handling message:', message, err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});
