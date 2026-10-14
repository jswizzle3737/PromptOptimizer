/**
 * Shared stubs for the unit tests. Run with:  node --no-warnings --test "unit/*.test.mjs"
 * No package.json and no toolchain, matching the project convention.
 */

function makeArea(store) {
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    }
  };
}

/**
 * In-memory chrome.storage.local and .session. Returns the backing objects so
 * tests can assert on what was persisted: `{ local, session }`.
 * (Passing `initial` seeds `local`.)
 */
export function installChromeStub(initial = {}) {
  const local = { ...initial };
  const session = {};
  globalThis.chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session),
      onChanged: { addListener() {} }
    }
  };
  // Existing tests read the local store directly off the return value.
  return Object.assign(local, { __session: session });
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Replace globalThis.fetch for one test; returns the recorded calls. */
export function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
