/**
 * Client side of the service worker's streaming 'optimize' port, shared by the
 * popup and the in-page panel.
 *
 * Starts one request and returns { promise, cancel }. The promise resolves
 * with the result, or with null when cancelled; it rejects with the worker's
 * error. `onStart(engine, model)` fires when an engine begins, again for each
 * fallback engine or model: the caller discards any text streamed so far.
 * `onStatus(info)` reports transient retry states (e.g. 429 rate-limit backoff).
 */
export function startRun(payload, { onStart, onToken, onStatus, onApproval } = {}) {
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
    if (msg?.type === 'start') onStart?.(msg.engine, msg.model);
    else if (msg?.type === 'token') onToken?.(msg.delta);
    else if (msg?.type === 'status') onStatus?.(msg);
    else if (msg?.type === 'approval') {
      // onApproval returns true/false, or { approved, remember } to skip the
      // same provider's notice for the rest of the browser session.
      Promise.resolve().then(() => onApproval?.(msg.details)).then(
        answer => replyToApproval(msg.id, answer === true || answer?.approved === true, answer?.remember === true),
        () => replyToApproval(msg.id, false, false)
      );
    }
    else if (msg?.type === 'done') finish(resolveRun, msg.data);
    else if (msg?.type === 'cancelled') finish(resolveRun, null);
    else if (msg?.type === 'error') finish(rejectRun, new Error(msg.error));
  });
  port.onDisconnect.addListener(() =>
    finish(rejectRun, new Error('The extension stopped responding. Reload the page and try again.')));
  port.postMessage({ type: 'start', payload });

  function replyToApproval(id, approved, remember) {
    if (settled) return;
    try { port.postMessage({ type: 'approval', id, approved, remember: approved && remember }); } catch { /* already closed */ }
  }

  return {
    promise,
    cancel() {
      if (settled) return;
      try { port.postMessage({ type: 'cancel' }); } catch { /* already closed */ }
    }
  };
}

/** Mutations from extension pages share the service worker's write queue. */
export async function writeUserData(operation, payload) {
  const response = await chrome.runtime.sendMessage({ type: 'WRITE_USER_DATA', operation, payload });
  if (!response?.success) throw new Error(response?.error || 'Could not save locally.');
  return response.data;
}
