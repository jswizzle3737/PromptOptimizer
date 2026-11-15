/**
 * Chrome's built-in Prompt API (Gemini Nano), run where it actually exists.
 *
 * The API is exposed to documents, not workers, so the service worker cannot
 * call it. Extension pages (popup, Options, the offscreen document) can; the
 * worker reaches it through the offscreen document (background/nano-bridge.js).
 * This module is the one implementation both sides share.
 */

export const NANO_LANGUAGES = [{ type: 'text', languages: ['en'] }];
export const NANO_SESSION_OPTIONS = {
  expectedInputs: NANO_LANGUAGES,
  expectedOutputs: NANO_LANGUAGES
};

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
      availability = await LanguageModel.availability(NANO_SESSION_OPTIONS);
    } catch (err) {
      // Only fall back for older signatures that reject options with TypeError;
      // NotSupportedError (e.g. model execution flag disabled) must not trigger a second native call.
      if (err?.name !== 'TypeError') throw err;
      availability = await LanguageModel.availability();
    }
    return { available: availability === 'available', status: availability };
  } catch (err) {
    return { available: false, status: 'error', error: err?.message || String(err) };
  }
}

export function nanoStatusError(status) {
  if (status.status === 'error') {
    const msg = String(status.error || '').trim();
    if (/feature flag|gating model execution/i.test(msg)) {
      return `Chrome Nano model execution flag is disabled (${msg}). Enable chrome://flags/#prompt-api-for-gemini-nano and chrome://flags/#optimization-guide-on-device-model, or choose another engine in Settings.`;
    }
    return `Could not probe the Chrome Prompt API: ${msg}`;
  }
  return NANO_STATE_ERRORS[status.status] || `Chrome built-in Prompt API reported "${status.status}".`;
}

const NANO_QUOTA_ERROR =
  'Chrome Nano prompt exceeded its on-device context limit. Try disabling page context or using a shorter draft.';

async function fitMessageToNanoQuota(session, userMessage, signal) {
  let msg = String(userMessage ?? '');
  const quota = typeof session?.inputQuota === 'number' && session.inputQuota > 0
    ? session.inputQuota
    : 0;
  if (!quota || typeof session.measureInputUsage !== 'function') return msg;

  const safeBudget = Math.max(128, quota - Math.min(256, Math.floor(quota * 0.15)));
  let usage;
  try {
    usage = await session.measureInputUsage(msg, { signal });
  } catch {
    return msg;
  }
  if (!Number.isFinite(usage) || usage <= safeBudget) return msg;

  const ctxMatch = msg.match(/\n\n<page_context>\n([\s\S]*?)\n<\/page_context>/);
  if (ctxMatch) {
    const baseMsg = msg.replace(ctxMatch[0], '');
    const halfCtx = ctxBodySlice(ctxMatch[1]);
    if (halfCtx) {
      const trimmedMsg = `${baseMsg}\n\n<page_context>\n${halfCtx}\n</page_context>`;
      try {
        const u2 = await session.measureInputUsage(trimmedMsg, { signal });
        if (Number.isFinite(u2) && u2 <= safeBudget) return trimmedMsg;
      } catch { /* fall through */ }
    }
    msg = baseMsg;
    try {
      const u3 = await session.measureInputUsage(msg, { signal });
      if (Number.isFinite(u3) && u3 <= safeBudget) return msg;
    } catch { /* fall through */ }
  }

  throw new Error(NANO_QUOTA_ERROR);
}

function ctxBodySlice(body) {
  const trimmed = String(body || '').trim();
  if (trimmed.length < 240) return '';
  return trimmed.slice(0, Math.floor(trimmed.length / 2));
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
      ...NANO_SESSION_OPTIONS,
      signal: combined
    });

    const boundedMessage = await fitMessageToNanoQuota(session, userMessage, combined);

    if (typeof onToken !== 'function' || typeof session.promptStreaming !== 'function') {
      return { text: await session.prompt(boundedMessage, { signal: combined }), truncated: false };
    }

    /* Older Chrome builds yielded the whole text so far on every chunk; current
       builds yield deltas. Accept both. */
    let text = '';
    for await (const chunk of session.promptStreaming(boundedMessage, { signal: combined })) {
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
    if (err?.name === 'QuotaExceededError') {
      throw new Error(NANO_QUOTA_ERROR);
    }
    if (/feature flag|gating model execution/i.test(err?.message || '')) {
      throw new Error(nanoStatusError({ status: 'error', error: err.message }));
    }
    throw err;
  } finally {
    try { session?.destroy?.(); } catch { /* already gone */ }
  }
}
