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
import { EMAIL_STYLE_KEY } from '../shared/email-draft.js';

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
      if (msg?.type === 'email-style') {
        if (port.sender?.id !== chrome.runtime.id || port.sender.tab) throw new Error('Writing style is private to the extension.');
        const profile = JSON.parse(localStorage.getItem(EMAIL_STYLE_KEY) || 'null');
        post({ type: 'email-style', profile });
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
