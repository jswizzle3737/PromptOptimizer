/**
 * Runs Gemini Nano for the service worker (see background/nano-bridge.js).
 *
 * One port per request, named 'nano'. The worker posts one message:
 *   { type: 'status' }                → { type: 'status', status }
 *   { type: 'prompt', args }          → { type: 'token', delta }*, then
 *                                       { type: 'done', text, truncated } or
 *                                       { type: 'error', message }
 * Disconnecting the port cancels the prompt.
 */
import { checkLocalNanoStatus, runLocalNano } from '../shared/nano.js';

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'nano') return;
  const ctl = new AbortController();
  port.onDisconnect.addListener(() => ctl.abort());

  port.onMessage.addListener(async msg => {
    const post = m => { try { port.postMessage(m); } catch { /* worker went away */ } };
    try {
      if (msg?.type === 'status') {
        post({ type: 'status', status: await checkLocalNanoStatus() });
        return;
      }
      if (msg?.type === 'prompt') {
        const { systemPrompt, userMessage, timeoutMs, stream } = msg.args || {};
        const out = await runLocalNano({
          systemPrompt,
          userMessage,
          timeoutMs,
          signal: ctl.signal,
          onToken: stream ? delta => post({ type: 'token', delta }) : undefined
        });
        post({ type: 'done', text: out.text, truncated: out.truncated });
      }
    } catch (err) {
      if (!ctl.signal.aborted) post({ type: 'error', message: err?.message || String(err) });
    }
  });
});
