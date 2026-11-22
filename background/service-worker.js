/**
 * Background Service Worker for PromptOptimizer
 * Handles the context menu, the keyboard command, per-site opt-in, and message
 * passing from content scripts and extension pages. Nothing is kept in module
 * state: the worker is terminated after ~30s idle, so anything that must survive
 * lives in chrome.storage.
 */

import {
  optimizePrompt, refinePrompt, clarifyPrompt, repairPrompt, draftEmailReply,
  setNanoBackend, setNanoJudgeBackend, CancelledError
} from '../shared/optimizer-engine.js';
import { nanoBridge, readSavedEmailStyle } from './nano-bridge.js';
import { GMAIL_ORIGIN } from '../shared/email-draft.js';
import { isEngine } from '../shared/engines.js';
import { detectSecrets } from '../shared/secrets.js';
import {
  addHistoryEntry, removeHistoryEntry, clearHistory, saveSettings, getSites, setPendingPrompt, SITES_KEY, migrateTheme
} from '../shared/storage.js';
import { saveToLibrary, updateLibraryEntry, deleteLibraryEntry, getLibrary, collectLabels } from '../shared/library.js';
import { saveFrameworks, upsertFramework, deleteFramework, resetFrameworksToDefault } from '../shared/frameworks.js';

const MENU_ID = 'promptcraft-optimize-selection';

// The Prompt API lives in documents, not workers: run Nano (and judge) offscreen.
if (chrome.offscreen) {
  setNanoBackend(nanoBridge);
  setNanoJudgeBackend(nanoBridge);
}

const SITE_SCRIPT_PREFIX = 'promptcraft-site-';
const activeSiteRuns = new Map();

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

  await saveSettings({});

  /* Deliberately NOT opening the Options page on install.
     A settings console is not a welcome — it greets a first-time user with API
     keys and chrome:// flags before they know what the tool does. First-run
     guidance lives inline in the popup, and Options is reached only when the
     user chooses an engine that needs a key. */

  // Dynamically registered scripts do not reliably survive an extension update.
  await writeUserData(syncSiteScripts);
});

chrome.runtime.onStartup.addListener(() => writeUserData(syncSiteScripts));

chrome.permissions.onRemoved.addListener(() => writeUserData(syncSiteScripts));

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
  const gmail = origin === GMAIL_ORIGIN;
  const config = {
    id,
    matches: [`${origin}/*`],
    js: [gmail ? 'content/gmail-replies.js' : 'content/content.js'],
    css: gmail ? [] : ['content/content.css'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  };
  if (!existing.length) await chrome.scripting.registerContentScripts([config]);
  else if (existing[0].js?.[0] !== config.js[0]) await chrome.scripting.updateContentScripts([config]);
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
    for (const origin of sites) {
      if (!granted.includes(origin)) cancelSiteRuns(origin);
    }
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
  await registerSite(origin);
  if (!sites.includes(origin)) await chrome.storage.local.set({ [SITES_KEY]: [...sites, origin] });

  // Registration only affects pages loaded from now on; put the button on the
  // page the user is looking at as well.
  if (tabId != null) {
    try {
      const gmail = origin === GMAIL_ORIGIN;
      if (!gmail) await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: [gmail ? 'content/gmail-replies.js' : 'content/content.js'] });
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
  cancelSiteRuns(origin);
  const tabs = await chrome.tabs.query({ url: `${origin}/*` }).catch(() => []);
  await Promise.allSettled(tabs.filter(tab => tab.id != null).map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: 'OPTIMIZER_SITE_DISABLED', origin })));
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

function cancelSiteRuns(origin) {
  for (const controller of activeSiteRuns.get(origin) || []) controller.abort();
}

async function runFromSender(payload, sender, controller, io = {}) {
  const origin = sender?.tab ? toOrigin(sender.url || sender.tab.url) : null;
  let runs;
  if (origin) {
    runs = activeSiteRuns.get(origin) || new Set();
    activeSiteRuns.set(origin, runs);
    runs.add(controller);
  }
  try {
    return await runRequest(payload, sender, { ...io, signal: controller.signal });
  } finally {
    runs?.delete(controller);
    if (runs?.size === 0) activeSiteRuns.delete(origin);
  }
}

/**
 * Run one request from the popup or a page.
 * payload.action: 'optimize' (default) | 'refine' | 'clarify' | 'repair'.
 * `io` carries { signal, onToken, onStart, onStatus } when the caller streams.
 */
async function runRequest(payload = {}, sender, io = {}) {
  const { action = 'optimize', text, frameworkId, engine, host, context, variantCount, kind, previous, instruction } = payload;
  const gmail = action === 'draft-gmail';
  const email = action === 'draft-email' || gmail;
  if (gmail && (sender?.frameId !== 0 || toOrigin(sender.tab?.url) !== GMAIL_ORIGIN ||
      toOrigin(sender.url) !== GMAIL_ORIGIN || !(await getSites()).includes(GMAIL_ORIGIN))) {
    throw new Error('Enable the reply star on Gmail from the PromptOptimizer toolbar.');
  }
  if (action === 'draft-email' && sender?.url !== chrome.runtime.getURL('options/email-reply.html')) {
    throw new Error('Open Email replies from the extension to draft a reply.');
  }
  /* The host tunes the rewrite for the target model. Prefer the sender tab's
     own URL (content script) — a popup can only claim a host, the active tab
     is what it actually shows. */
  const senderHost = (() => {
    try { return new URL(sender?.tab?.url || '').hostname; } catch { return null; }
  })();
  const common = {
    frameworkId, engine, host: senderHost || host, ...io,
    async beforeSend({ engine: destination, model, origin, fallback, systemPrompt, userMessage }) {
      const secrets = [...new Set([...detectSecrets(systemPrompt), ...detectSecrets(userMessage)])];
      if (!email && !fallback && !secrets.length) return;
      const approved = await io.requestApproval?.({ engine: destination, model, origin, fallback, secrets, ...(email && { email }) });
      if (!approved || io.signal?.aborted) throw new CancelledError();
    }
  };

  if (gmail) {
    const profile = await readSavedEmailStyle(io.signal);
    const samples = (profile?.samples || []).filter(sample => sample?.selected).map(sample => sample.text);
    return draftEmailReply({ email: payload.email, notes: payload.notes, instructions: profile?.instructions, samples }, common);
  }
  if (email) return draftEmailReply(payload, common);

  if (action === 'clarify') {
    return clarifyPrompt(text, common);
  }
  if (action === 'repair') {
    return repairPrompt(text, common);
  }

  const result = action === 'refine'
    ? await refinePrompt(text, { ...common, kind, previous, instruction })
    : await optimizePrompt(text, { ...common, context, variantCount });

  if (io.signal?.aborted) throw new CancelledError();
  try {
    await writeUserData(() => addHistoryEntry({
      original: text,
      optimized: result.optimized,
      engine: result.engine,
      framework: result.framework,
      degraded: result.degraded
    }));
  } catch {
    return { ...result, historyWarning: 'The rewrite is ready. It could not be saved to history.' };
  }
  return result;
}

/**
 * Streaming requests. The caller connects a port named 'optimize' and posts
 * { type: 'start', payload }; the worker answers with
 *   { type: 'start', engine, model? }   an engine began (discard any streamed text)
 *   { type: 'token', delta }            streamed text
 *   { type: 'status', kind, ... }       transient status (e.g. 429 retry wait)
 *   { type: 'done', data } | { type: 'error', error } | { type: 'cancelled' }
 * Posting { type: 'cancel' } or disconnecting aborts the request.
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'optimize') return;
  const ctl = new AbortController();
  port.onDisconnect.addListener(() => ctl.abort());
  const post = m => { try { port.postMessage(m); } catch { /* caller closed */ } };
  let started = false;
  let approvalId = 0;
  let pendingApproval = null;
  ctl.signal.addEventListener('abort', () => pendingApproval?.resolve(false), { once: true });

  function requestApproval(details) {
    if (ctl.signal.aborted) return false;
    return new Promise(resolve => {
      const id = ++approvalId;
      pendingApproval = { id, resolve };
      post({ type: 'approval', id, details });
    });
  }

  port.onMessage.addListener(async msg => {
    if (msg?.type === 'cancel') { ctl.abort(); return; }
    if (msg?.type === 'approval' && pendingApproval?.id === msg.id) {
      const { resolve } = pendingApproval;
      pendingApproval = null;
      resolve(msg.approved === true);
      return;
    }
    if (msg?.type !== 'start' || started) return;
    started = true;
    try {
      const data = await runFromSender(msg.payload, port.sender, ctl, {
        requestApproval,
        onToken: delta => post({ type: 'token', delta }),
        onStart: (engine, model) => post({ type: 'start', engine, ...(model && { model }) }),
        onStatus: info => post({ ...(info || {}), kind: info?.type || 'status', type: 'status' })
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

/** Messages only extension pages may send, including Options opened as a tab. */
const PAGE_ONLY = new Set(['ENABLE_SITE', 'DISABLE_SITE', 'WRITE_USER_DATA']);
const PORT_ACTIONS = new Set(['optimize', 'refine', 'clarify', 'repair']);

let writes = Promise.resolve();
function writeUserData(operation) {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}

const USER_WRITES = new Map([
  ['saveSettings', patch => saveSettings(patch)],
  ['clearHistory', () => clearHistory()],
  ['removeHistoryEntry', id => removeHistoryEntry(id)],
  ['saveToLibrary', entry => saveToLibrary(entry)],
  ['updateLibraryEntry', ({ id, patch }) => updateLibraryEntry(id, patch)],
  ['deleteLibraryEntry', id => deleteLibraryEntry(id)],
  ['saveFrameworks', frameworks => saveFrameworks(frameworks)],
  ['upsertFramework', framework => upsertFramework(framework)],
  ['deleteFramework', id => deleteFramework(id)],
  ['resetFrameworksToDefault', () => resetFrameworksToDefault()]
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (PAGE_ONLY.has(message.type) && sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) {
        throw new Error('Not allowed from a web page.');
      }

      switch (message.type) {
        case 'WRITE_USER_DATA': {
          const operation = USER_WRITES.get(message.operation);
          if (!operation) throw new Error('Unknown storage operation.');
          const data = await writeUserData(() => operation(message.payload));
          sendResponse({ success: true, data });
          break;
        }

        case 'OPTIMIZE_PROMPT': {
          // One-shot form of the 'optimize' port below, without streaming.
          const action = PORT_ACTIONS.has(message.payload?.action) ? message.payload.action : 'optimize';
          const data = await runFromSender({ ...message.payload, action }, sender, new AbortController());
          sendResponse({ success: true, data });
          break;
        }

        case 'SET_THEME': {
          // The in-page panel's design picker. Normalised here, so a page cannot
          // store an arbitrary value, and written as one field.
          const saved = await writeUserData(() => saveSettings({ theme: migrateTheme(message.payload?.theme) }));
          sendResponse({ success: true, theme: saved.theme });
          break;
        }

        case 'SET_VARIANTS': {
          // The in-page panel's variant-count picker. Clamped here for the same
          // reason SET_THEME normalises: a page never stores arbitrary values.
          const count = Math.max(1, Math.min(3, parseInt(message.payload?.count, 10) || 1));
          const saved = await writeUserData(() => saveSettings({ variantCount: count }));
          sendResponse({ success: true, variantCount: saved.variantCount });
          break;
        }

        case 'SET_PAGE_CONTEXT': {
          // The in-page panel's "Use page context" switch: one boolean field.
          const saved = await writeUserData(() => saveSettings({ includePageContext: message.payload?.enabled === true }));
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
          const patch = engineId === 'omniroute'
            ? { preferredEngine: engineId, omnirouteEnabled: true }
            : { preferredEngine: engineId };
          const saved = await writeUserData(() => saveSettings(patch));
          sendResponse({ success: true, preferredEngine: saved.preferredEngine });
          break;
        }

        case 'OPEN_OPTIONS': {
          await chrome.runtime.openOptionsPage();
          sendResponse({ success: true });
          break;
        }

        case 'SAVE_PROMPT': {
          // From the in-page modal, which has no direct route to the library.
          const { title, text, original, labels, framework, engine } = message.payload || {};
          const entry = await writeUserData(() => saveToLibrary({ title, text, original, labels, framework, engine }));
          sendResponse({ success: true, id: entry.id });
          break;
        }

        case 'LIBRARY_LABELS':
          sendResponse({ success: true, labels: collectLabels(await getLibrary()) });
          break;

        case 'ENABLE_SITE':
          sendResponse({ success: true, origin: await writeUserData(() => enableSite(message.origin, message.tabId)) });
          break;

        case 'DISABLE_SITE':
          sendResponse({ success: true, origin: await writeUserData(() => disableSite(message.origin)) });
          break;

        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error('Service worker error handling message:', message.type, err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});
