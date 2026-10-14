import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers.mjs';

/* The worker registers its listeners at import time, so stub chrome first, import
   once, and drive the captured listeners with per-test behaviour. */
const listeners = {};
const on = name => ({ addListener: fn => { (listeners[name] ||= []).push(fn); } });

const calls = [];
const behaviour = {};
let registered = [];

function resetBehaviour() {
  calls.length = 0;
  registered = [];
  for (const k of Object.keys(behaviour)) delete behaviour[k];
  Object.assign(behaviour, {
    sendMessage: async () => undefined,
    executeScript: async () => undefined,
    openPopup: async () => undefined,
    contains: async () => true,
    queryTabs: async () => [{ id: 7 }]
  });
}
resetBehaviour();

const stub = installChromeStub();
Object.assign(globalThis.chrome, {
  runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'), onConnect: on('connect') },
  permissions: {
    onRemoved: on('permRemoved'),
    contains: async q => { calls.push(['contains', q]); return behaviour.contains(q); },
    remove: async q => { calls.push(['remove', q]); }
  },
  contextMenus: {
    onClicked: on('menu'),
    removeAll: async () => { calls.push(['removeAll']); },
    create: o => { calls.push(['create', o.id]); }
  },
  commands: { onCommand: on('command') },
  tabs: {
    sendMessage: async (id, msg) => { calls.push(['sendMessage', id, msg]); return behaviour.sendMessage(id, msg); },
    query: async q => { calls.push(['query', q]); return behaviour.queryTabs(q); }
  },
  scripting: {
    insertCSS: async o => { calls.push(['insertCSS', o.target.tabId]); },
    executeScript: async o => { calls.push(['executeScript', o.target.tabId]); return behaviour.executeScript(o); },
    getRegisteredContentScripts: async () => registered,
    registerContentScripts: async list => { calls.push(['register', list[0].id, list[0].matches]); registered.push(...list); },
    unregisterContentScripts: async ({ ids }) => { calls.push(['unregister', ids]); registered = registered.filter(s => !ids.includes(s.id)); }
  },
  action: {
    openPopup: async () => { calls.push(['openPopup']); return behaviour.openPopup(); },
    setBadgeText: async o => { calls.push(['badge', o.text]); },
    setTitle: async o => { calls.push(['title', o.title]); }
  }
});

await import('../background/service-worker.js');

const fire = (name, ...args) => Promise.all((listeners[name] || []).map(fn => fn(...args)));
const names = () => calls.map(c => c[0]);
const sent = () => calls.filter(c => c[0] === 'sendMessage').map(c => c[2]);

beforeEach(() => {
  resetBehaviour();
  for (const k of Object.keys(stub)) if (k !== '__session') delete stub[k];
  for (const k of Object.keys(stub.__session)) delete stub.__session[k];
});

/* ----------------------------------------------------------- opening */

test('context menu with a selection messages the tab and runs immediately', async () => {
  await fire('menu', { menuItemId: 'promptcraft-optimize-selection', selectionText: '  fix my draft ' }, { id: 7 });
  assert.deepEqual(sent(), [{
    type: 'OPEN_OPTIMIZER_MODAL',
    payload: { text: 'fix my draft', autoRun: true, fromContextMenu: true }
  }]);
  assert.ok(!names().includes('executeScript'), 'no injection when the script is already there');
});

test('context menu on an empty editable still opens the modal, without auto-run', async () => {
  await fire('menu', { menuItemId: 'promptcraft-optimize-selection', selectionText: '' }, { id: 7 });
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].payload.text, '');
  assert.equal(sent()[0].payload.autoRun, false);
});

test('other menu ids are ignored', async () => {
  await fire('menu', { menuItemId: 'something-else', selectionText: 'x' }, { id: 7 });
  assert.equal(calls.length, 0);
});

test('a tab with no content script gets one injected, then the message', async () => {
  let first = true;
  behaviour.sendMessage = async () => {
    if (first) { first = false; throw new Error('Receiving end does not exist'); }
  };
  await fire('menu', { menuItemId: 'promptcraft-optimize-selection', selectionText: 'hello' }, { id: 7 });
  assert.deepEqual(names().filter(n => n !== 'query'), ['sendMessage', 'insertCSS', 'executeScript', 'sendMessage']);
});

test('a page extensions cannot script falls back to the popup with the text parked', async () => {
  behaviour.sendMessage = async () => { throw new Error('nope'); };
  behaviour.executeScript = async () => { throw new Error('Cannot access a chrome:// URL'); };
  await fire('menu', { menuItemId: 'promptcraft-optimize-selection', selectionText: 'my draft' }, { id: 7 });

  assert.ok(names().includes('openPopup'));
  assert.equal(stub.__session.promptcraft_pending.text, 'my draft');
  assert.equal(stub.__session.promptcraft_pending.autoRun, true);
  assert.ok(!('promptcraft_pending' in stub), 'never written to persistent storage');
});

test('if even the popup cannot open, the user is told through the badge', async () => {
  behaviour.sendMessage = async () => { throw new Error('nope'); };
  behaviour.executeScript = async () => { throw new Error('restricted'); };
  behaviour.openPopup = async () => { throw new Error('no window'); };
  await fire('menu', { menuItemId: 'promptcraft-optimize-selection', selectionText: 'x' }, { id: 7 });
  assert.ok(calls.some(c => c[0] === 'badge' && c[1] === '!'));
  assert.ok(calls.some(c => c[0] === 'title'));
});

test('keyboard command opens the modal in the tab it was invoked on', async () => {
  await fire('command', 'open-optimizer', { id: 9 });
  assert.deepEqual(sent(), [{
    type: 'OPEN_OPTIMIZER_MODAL',
    payload: { text: '', fromShortcut: true }
  }]);
  assert.equal(calls.find(c => c[0] === 'sendMessage')[1], 9);
});

test('keyboard command without a tab argument looks up the active tab', async () => {
  await fire('command', 'open-optimizer', undefined);
  assert.equal(calls.find(c => c[0] === 'sendMessage')[1], 7);
});

test('other commands are ignored', async () => {
  await fire('command', 'unrelated', { id: 9 });
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------- install/update */

test('install recreates the menu from scratch and migrates stored settings', async () => {
  Object.assign(stub, { promptcraft_settings: { schemaVersion: 2, geminiModel: 'gemini-1.5-flash' } });
  await fire('installed', { reason: 'update' });
  assert.deepEqual(names().slice(0, 2), ['removeAll', 'create'], 'removeAll must precede create');
  assert.equal(stub.promptcraft_settings.schemaVersion, 3);
  assert.notEqual(stub.promptcraft_settings.geminiModel, 'gemini-1.5-flash');
});

/* ----------------------------------------------------------- site opt-in */

const send = (message, sender = {}) => new Promise(resolve => {
  const [listener] = listeners.message;
  listener(message, sender, resolve);
});

test('a web page cannot enable a site', async () => {
  const res = await send({ type: 'ENABLE_SITE', origin: 'https://example.com' }, { tab: { id: 1 } });
  assert.equal(res.success, false);
  assert.match(res.error, /not allowed/i);
  assert.ok(!names().includes('register'));
});

test('enabling a site requires a permission the user actually granted', async () => {
  behaviour.contains = async () => false;
  const res = await send({ type: 'ENABLE_SITE', origin: 'https://example.com' });
  assert.equal(res.success, false);
  assert.match(res.error, /permission/i);
  assert.ok(!names().includes('register'));
});

test('enabling a site registers a script for that origin only and records it', async () => {
  const res = await send({ type: 'ENABLE_SITE', origin: 'https://example.com/some/path?q=1' });
  assert.equal(res.success, true);
  assert.equal(res.origin, 'https://example.com');
  const reg = calls.find(c => c[0] === 'register');
  assert.deepEqual(reg[2], ['https://example.com/*']);
  assert.deepEqual(stub.promptcraft_sites, ['https://example.com']);
});

test('non-web origins are refused', async () => {
  const res = await send({ type: 'ENABLE_SITE', origin: 'chrome://extensions' });
  assert.equal(res.success, false);
});

test('enabling also injects into the page the user is on', async () => {
  await send({ type: 'ENABLE_SITE', origin: 'https://example.com', tabId: 5 });
  assert.ok(calls.some(c => c[0] === 'executeScript' && c[1] === 5));
});

test('disabling a site drops the opt-in and its registered script', async () => {
  await send({ type: 'ENABLE_SITE', origin: 'https://example.com' });
  calls.length = 0;
  behaviour.contains = async () => false; // permission is gone after removal
  const res = await send({ type: 'DISABLE_SITE', origin: 'https://example.com' });
  assert.equal(res.success, true);
  assert.deepEqual(stub.promptcraft_sites, []);
  assert.ok(calls.some(c => c[0] === 'unregister'));
});

test('a revoked permission is reconciled on startup', async () => {
  await send({ type: 'ENABLE_SITE', origin: 'https://example.com' });
  calls.length = 0;
  behaviour.contains = async () => false;
  await fire('startup');
  assert.deepEqual(stub.promptcraft_sites, []);
  assert.ok(calls.some(c => c[0] === 'unregister'));
});

test('unknown message types get an error, not silence', async () => {
  const res = await send({ type: 'NOPE' });
  assert.equal(res.success, false);
  assert.match(res.error, /unknown/i);
});

/* ---------------------------------------------------------- saved prompts */

test('the in-page modal can save a labelled prompt through the worker', async () => {
  const res = await send({
    type: 'SAVE_PROMPT',
    payload: {
      title: 'Cold email', text: 'Write a cold email', original: 'cold email',
      labels: 'sales, email', framework: 'rtf', engine: 'offline'
    }
  }, { tab: { id: 3 } });
  assert.equal(res.success, true);
  assert.match(res.id, /^lib_/);
  assert.equal(stub.promptcraft_library.length, 1);
  assert.equal(stub.promptcraft_library[0].title, 'Cold email');
  assert.deepEqual(stub.promptcraft_library[0].labels, ['sales', 'email']);
});

test('saving an empty prompt is refused and nothing is stored', async () => {
  const res = await send({ type: 'SAVE_PROMPT', payload: { title: 'x', text: '   ' } }, { tab: { id: 3 } });
  assert.equal(res.success, false);
  assert.match(res.error, /empty/i);
  assert.ok(!('promptcraft_library' in stub));
});

test('LIBRARY_LABELS reports labels in use with counts', async () => {
  await send({ type: 'SAVE_PROMPT', payload: { text: 'one', labels: 'a, b' } }, { tab: { id: 3 } });
  await send({ type: 'SAVE_PROMPT', payload: { text: 'two', labels: 'a' } }, { tab: { id: 3 } });
  const res = await send({ type: 'LIBRARY_LABELS' }, { tab: { id: 3 } });
  assert.equal(res.success, true);
  assert.deepEqual(res.labels, [{ label: 'a', count: 2 }, { label: 'b', count: 1 }]);
});

/* ----------------------------------------------------------- design from a page */

test('the in-page design picker writes one field through the worker', async () => {
  Object.assign(stub, {
    promptcraft_settings: { schemaVersion: 3, theme: 'dark', geminiApiKey: 'keep-me', preferredEngine: 'offline' }
  });
  const res = await send({ type: 'SET_THEME', payload: { theme: 'ember' } }, { tab: { id: 3 } });
  assert.equal(res.success, true);
  assert.equal(res.theme, 'ember');
  assert.equal(stub.promptcraft_settings.theme, 'ember');
  assert.equal(stub.promptcraft_settings.geminiApiKey, 'keep-me', 'other fields, keys included, are untouched');
  assert.equal(stub.promptcraft_settings.preferredEngine, 'offline');
  assert.equal(stub.promptcraft_settings.schemaVersion, 3);
});

test('a page cannot store an arbitrary or retired design', async () => {
  for (const bad of ['<script>', 'cyberpunk', '', undefined]) {
    const res = await send({ type: 'SET_THEME', payload: { theme: bad } }, { tab: { id: 3 } });
    assert.equal(res.success, true);
    assert.equal(res.theme, 'dark', 'falls back to the default for ' + String(bad));
  }
});

test('the in-page design write migrates old settings instead of preserving them stale', async () => {
  Object.assign(stub, { promptcraft_settings: { schemaVersion: 2, geminiModel: 'gemini-1.5-flash', theme: 'dark' } });
  await send({ type: 'SET_THEME', payload: { theme: 'harbor' } }, { tab: { id: 3 } });
  assert.equal(stub.promptcraft_settings.schemaVersion, 3);
  assert.notEqual(stub.promptcraft_settings.geminiModel, 'gemini-1.5-flash');
});

/* ----------------------------------------------------------- streaming port */

/** A fake runtime Port: records what the worker posts, lets the test post. */
function fakePort(name = 'optimize', sender = {}) {
  const msgL = [];
  const discL = [];
  const posted = [];
  return {
    name,
    sender,
    posted,
    onMessage: { addListener: fn => msgL.push(fn) },
    onDisconnect: { addListener: fn => discL.push(fn) },
    postMessage: m => posted.push(m),
    send: m => Promise.all(msgL.map(fn => fn(m))),
    disconnect: () => discL.forEach(fn => fn())
  };
}

const settle = () => new Promise(r => setTimeout(r, 30));

test('optimize port: an offline run posts start-free done with the result', async () => {
  stub.promptcraft_settings = { schemaVersion: 3, preferredEngine: 'offline' };
  const port = fakePort();
  await fire('connect', port);
  await port.send({ type: 'start', payload: { text: 'write a haiku' } });
  await settle();
  const done = port.posted.find(m => m.type === 'done');
  assert.ok(done, JSON.stringify(port.posted));
  assert.equal(done.data.engine, 'offline');
  assert.ok(done.data.optimized.length > 20);
});

test('optimize port: cancel aborts an in-flight request and reports cancelled', async () => {
  stub.promptcraft_settings = { schemaVersion: 3, preferredEngine: 'openai', openaiApiKey: 'K' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((_, reject) =>
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  try {
    const port = fakePort();
    await fire('connect', port);
    const running = port.send({ type: 'start', payload: { text: 'write a haiku' } });
    await settle();
    await port.send({ type: 'cancel' });
    await running;
    await settle();
    assert.deepEqual(port.posted.map(m => m.type), ['start', 'cancelled']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('optimize port: refine routes to refinePrompt and errors are posted, not thrown', async () => {
  stub.promptcraft_settings = { schemaVersion: 3, preferredEngine: 'offline' };
  const port = fakePort();
  await fire('connect', port);
  await port.send({ type: 'start', payload: { action: 'refine', kind: 'shorter', previous: 'x', text: 'y' } });
  await settle();
  const last = port.posted.at(-1);
  assert.equal(last.type, 'error');
  assert.match(last.error, /needs an AI engine/);
});

test('ports with other names are ignored', async () => {
  const port = fakePort('nano');
  await fire('connect', port);
  await port.send({ type: 'start', payload: { text: 'x' } });
  await settle();
  assert.deepEqual(port.posted, []);
});
