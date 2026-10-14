/**
 * Chrome's built-in Prompt API (Gemini Nano), run where it actually exists.
 *
 * The API is exposed to documents, not workers, so the service worker cannot
 * call it. Extension pages (popup, Options, the offscreen document) can; the
 * worker reaches it through the offscreen document (background/nano-bridge.js).
 * This module is the one implementation both sides share.
 */

const NANO_LANGUAGES = [{ type: 'text', languages: ['en'] }];

export const NANO_STATE_ERRORS = {
  unsupported: 'Chrome built-in Prompt API is not supported in this browser.',
  downloadable: 'Chrome\'s on-device model has not been downloaded yet.',
  downloading: 'Chrome\'s on-device model is still downloading.',
  unavailable: 'Chrome built-in Prompt API is unavailable on this device. Check chrome://flags/#prompt-api-for-gemini-nano or use another engine.'
};

/**
 * `status` is one of 'available' | 'downloadable' | 'downloading' | 'unavailable',
 * or 'unsupported' / 'error' when the API cannot be probed at all.
 * @returns {Promise<{ available: boolean, status: string, error?: string }>}
 */
export async function checkLocalNanoStatus() {
  try {
    const LanguageModel = globalThis.LanguageModel;
    if (!LanguageModel) return { available: false, status: 'unsupported' };

    let availability;
    try {
      availability = await LanguageModel.availability({
        expectedInputs: NANO_LANGUAGES,
        expectedOutputs: NANO_LANGUAGES
      });
    } catch {
      availability = await LanguageModel.availability();
    }
    return { available: availability === 'available', status: availability };
  } catch (err) {
    return { available: false, status: 'error', error: err.message };
  }
}

export function nanoStatusError(status) {
  return status.status === 'error'
    ? `Could not probe the Chrome Prompt API: ${status.error}`
    : (NANO_STATE_ERRORS[status.status] || `Chrome built-in Prompt API reported "${status.status}".`);
}

/**
 * One prompt against the local model. Streams through `onToken` when given.
 * Throws on any failure; `signal` aborting surfaces as an AbortError.
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function runLocalNano({ systemPrompt, userMessage, timeoutMs, signal, onToken }) {
  const status = await checkLocalNanoStatus();
  if (!status.available) throw new Error(nanoStatusError(status));

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let session = null;
  try {
    session = await globalThis.LanguageModel.create({
      initialPrompts: [{ role: 'system', content: systemPrompt }],
      expectedInputs: NANO_LANGUAGES,
      expectedOutputs: NANO_LANGUAGES,
      signal: combined
    });

    if (typeof onToken !== 'function' || typeof session.promptStreaming !== 'function') {
      return { text: await session.prompt(userMessage, { signal: combined }), truncated: false };
    }

    /* Older Chrome builds yielded the whole text so far on every chunk; current
       builds yield deltas. Accept both. */
    let text = '';
    for await (const chunk of session.promptStreaming(userMessage, { signal: combined })) {
      const piece = String(chunk ?? '');
      const delta = piece.startsWith(text) && text ? piece.slice(text.length) : piece;
      if (!delta) continue;
      text += delta;
      onToken(delta);
    }
    return { text, truncated: false };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) {
      throw new Error(`Chrome Nano request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    try { session?.destroy?.(); } catch { /* already gone */ }
  }
}
