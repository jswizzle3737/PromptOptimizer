/**
 * Gemini Nano for the service worker, by way of an offscreen document.
 *
 * Chrome's Prompt API is exposed to documents, not workers, so calling it from
 * here always reported "not supported". The offscreen document
 * (offscreen/offscreen.js) runs the shared implementation in shared/nano.js;
 * this side opens it on demand and speaks to it over a port per request.
 */
import { CancelledError } from '../shared/optimizer-engine.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';

let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (existing.length) return;
  // Two requests at once must not both create it ("Only a single offscreen document").
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Runs Chrome\'s built-in on-device language model (Prompt API), which is not available in service workers.'
  }).finally(() => { creating = null; });
  await creating;
}

/** Open a port, send one message, and collect the reply stream. */
async function request(message, { signal, onToken } = {}) {
  await ensureOffscreen();
  if (signal?.aborted) throw new CancelledError();
  const port = chrome.runtime.connect({ name: 'nano' });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try { port.disconnect(); } catch { /* already closed */ }
      fn(value);
    };
    const onAbort = () => finish(reject, new CancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });

    port.onMessage.addListener(msg => {
      if (msg.type === 'token') onToken?.(msg.delta);
      else if (msg.type === 'status') finish(resolve, msg.status);
      else if (msg.type === 'done') finish(resolve, { text: msg.text, truncated: Boolean(msg.truncated) });
      else if (msg.type === 'error') finish(reject, new Error(msg.message));
    });
    port.onDisconnect.addListener(() =>
      finish(reject, new Error('The on-device model host closed unexpectedly.')));
    port.postMessage(message);
  });
}

/** The backend shape optimizer-engine's setNanoBackend expects. */
export const nanoBridge = {
  status: () => request({ type: 'status' }),
  prompt: ({ systemPrompt, userMessage, timeoutMs, signal, onToken }) =>
    request(
      { type: 'prompt', args: { systemPrompt, userMessage, timeoutMs, stream: typeof onToken === 'function' } },
      { signal, onToken }
    )
};
