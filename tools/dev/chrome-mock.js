// Minimal stand-in for the extension APIs so popup/options render in a normal tab.
// Storage persists in this origin's localStorage under "__mock_storage".
(() => {
  const KEY = '__mock_storage';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  let data = load();
  const listeners = new Set();
  const save = () => localStorage.setItem(KEY, JSON.stringify(data));
  const pick = keys => {
    if (keys == null) return { ...data };
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
  };
  const area = {
    get: async keys => pick(keys),
    set: async items => {
      const changes = {};
      for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); }
      save();
      listeners.forEach(l => l(changes, 'local'));
    },
    remove: async keys => { for (const k of [].concat(keys)) delete data[k]; save(); },
    clear: async () => { data = {}; save(); },
    setAccessLevel: async () => {}
  };
  const session = {};
  const manifest = (() => { const x = new XMLHttpRequest(); x.open('GET', '/manifest.json', false); x.send(); return JSON.parse(x.responseText); })();

  async function userWrite(operation, payload) {
    const storage = await import('/shared/storage.js');
    const library = await import('/shared/library.js');
    const frameworks = await import('/shared/frameworks.js');
    const ops = {
      saveSettings: p => storage.saveSettings(p),
      clearHistory: () => storage.clearHistory(),
      removeHistoryEntry: id => storage.removeHistoryEntry(id),
      saveToLibrary: e => library.saveToLibrary(e),
      updateLibraryEntry: ({ id, patch }) => library.updateLibraryEntry(id, patch),
      deleteLibraryEntry: id => library.deleteLibraryEntry(id),
      saveFrameworks: f => frameworks.saveFrameworks(f),
      upsertFramework: f => frameworks.upsertFramework(f),
      deleteFramework: id => frameworks.deleteFramework(id),
      resetFrameworksToDefault: () => frameworks.resetFrameworksToDefault()
    };
    return ops[operation](payload);
  }

  window.chrome = {
    storage: {
      local: area,
      session: { get: async k => ({ ...session }), set: async v => Object.assign(session, v), remove: async () => {} },
      onChanged: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l) }
    },
    runtime: {
      id: 'mock',
      getURL: f => '/' + f,
      getManifest: () => manifest,
      openOptionsPage: async () => { location.href = '/options/options.html'; },
      onMessage: { addListener: l => (window.__mockMessageListeners ??= []).push(l) },
      async sendMessage(message) {
        try {
          if (message.type === 'WRITE_USER_DATA') return { success: true, data: await userWrite(message.operation, message.payload) };
          if (message.type === 'READ_STATE') {
            const storage = await import('/shared/storage.js');
            const settings = await storage.getSettings();
            return { success: true, state: { settings, frameworks: data.promptcraft_frameworks, sites: [location.origin], library: [] } };
          }
          return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
      },
      connect() {
        const l = [];
        return { onMessage: { addListener: f => l.push(f) }, onDisconnect: { addListener() {} }, disconnect() {},
          postMessage(m) { if (m.type === 'start') setTimeout(() => l.forEach(f => f({ type: 'error', error: 'Mock: no engine.' })), 50); } };
      }
    },
    tabs: { query: async () => [{ id: 1, url: 'https://chatgpt.com/' }], create: async () => {} },
    permissions: { request: async () => true, contains: async () => true },
    action: { setTitle: async () => {}, setBadgeText: async () => {}, openPopup: async () => {} }
  };
})();
