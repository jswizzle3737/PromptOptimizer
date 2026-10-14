/**
 * Client side of the service worker's streaming 'optimize' port, shared by the
 * popup and the in-page panel.
 *
 * Starts one request and returns { promise, cancel }. The promise resolves
 * with the result, or with null when cancelled; it rejects with the worker's
 * error. `onStart(engine)` fires when an engine begins, again for each
 * fallback engine: the caller discards any text streamed so far.
 */
export function startRun(payload, { onStart, onToken } = {}) {
  const port = chrome.runtime.connect({ name: 'optimize' });
  let settled = false;
  let resolveRun;
  let rejectRun;
  const promise = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });

  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    try { port.disconnect(); } catch { /* already closed */ }
    fn(value);
  };

  port.onMessage.addListener(msg => {
    if (msg?.type === 'start') onStart?.(msg.engine);
    else if (msg?.type === 'token') onToken?.(msg.delta);
    else if (msg?.type === 'done') finish(resolveRun, msg.data);
    else if (msg?.type === 'cancelled') finish(resolveRun, null);
    else if (msg?.type === 'error') finish(rejectRun, new Error(msg.error));
  });
  port.onDisconnect.addListener(() =>
    finish(rejectRun, new Error('The extension stopped responding. Reload the page and try again.')));
  port.postMessage({ type: 'start', payload });

  return {
    promise,
    cancel() {
      if (settled) return;
      try { port.postMessage({ type: 'cancel' }); } catch { /* already closed */ }
    }
  };
}
