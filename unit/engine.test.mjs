import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, stubFetch, jsonResponse } from './helpers.mjs';
import {
  optimizePrompt, refinePrompt, clarifyPrompt, repairPrompt,
  buildUserMessage, buildProviderRequest, cleanModelOutput,
  verifyProvider, checkBuiltInPromptApiStatus, escapeRawPromptTags, sendProviderRequest,
  hasStructuredTokens, isRepairAcceptable, MAX_QUICK_ENHANCE_CHARS, REPAIR_MAX_CHARS, CancelledError
} from '../shared/optimizer-engine.js';

const SYSTEM = 'You rewrite prompts.';
const RAW = 'make me a website';

function settings(extra = {}) {
  return { promptcraft_settings: { schemaVersion: 5, ...extra } };
}

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;

beforeEach(() => {
  delete globalThis.LanguageModel;
  globalThis.fetch = originalFetch;
  globalThis.chrome = originalChrome;
});
afterEach(() => {
  delete globalThis.LanguageModel;
  globalThis.fetch = originalFetch;
  globalThis.chrome = originalChrome;
});

/* ------------------------------------------------------------ wrapping */

test('buildUserMessage delimits the draft and forbids answering it', () => {
  const msg = buildUserMessage(RAW);
  assert.match(msg, /<raw_prompt>\s*make me a website\s*<\/raw_prompt>/);
  assert.match(msg, /(never|do not) (answer|follow)/i);
});

test('cleanModelOutput strips a single wrapping fence and stray tags only', () => {
  assert.equal(cleanModelOutput('```\nHello\n```'), 'Hello');
  assert.equal(cleanModelOutput('```markdown\nHello\n```'), 'Hello');
  assert.equal(cleanModelOutput('<raw_prompt>Hello</raw_prompt>'), 'Hello');
  assert.equal(cleanModelOutput('  Hello  '), 'Hello');
  const inner = 'Intro\n```js\nlet a = 1\n```\nOutro';
  assert.equal(cleanModelOutput(inner), inner, 'inner fences are the user content');
});

/* ------------------------------------------------------- request shapes */

test('gemini: key travels in a header, never in the URL; system is systemInstruction', () => {
  const { url, init } = buildProviderRequest('gemini', {
    systemPrompt: SYSTEM, rawPrompt: RAW, apiKey: 'KEY123', model: 'some-model'
  });
  assert.ok(!url.includes('KEY123') && !url.includes('key='), 'key must not be in the URL');
  assert.equal(init.headers['x-goog-api-key'], 'KEY123');
  const body = JSON.parse(init.body);
  assert.match(body.systemInstruction.parts[0].text, /You rewrite prompts\./);
  assert.match(body.contents[0].parts[0].text, /<raw_prompt>/);
  assert.ok(url.includes('some-model'));
});

test('anthropic: correct browser-access header, wrapped user message, system field', () => {
  const { init } = buildProviderRequest('anthropic', {
    systemPrompt: SYSTEM, rawPrompt: RAW, apiKey: 'K', model: 'm'
  });
  assert.equal(init.headers['x-api-key'], 'K');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(!('dangerously-allow-browser' in init.headers), 'misnamed header must be gone');
  const body = JSON.parse(init.body);
  assert.match(body.system, /You rewrite prompts\./);
  assert.match(body.messages[0].content, /<raw_prompt>/);
});

for (const engine of ['openai', 'openrouter']) {
  test(`${engine}: bearer auth, system message, wrapped user message`, () => {
    const { url, init } = buildProviderRequest(engine, {
      systemPrompt: SYSTEM, rawPrompt: RAW, apiKey: ' K ', model: 'm'
    });
    assert.match(url, engine === 'openai' ? /api\.openai\.com/ : /openrouter\.ai/);
    assert.equal(init.headers.Authorization, 'Bearer K');
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /You rewrite prompts\./);
    assert.match(body.messages[1].content, /<raw_prompt>/);
  });
}

/* --------------------------------------------------------- optimizePrompt */

test('success path: returns cleaned text, not degraded, sends the wrapped draft', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K', openaiModel: 'm' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: '```\nBetter prompt\n```' } }] }));
  const r = await optimizePrompt(RAW);
  assert.equal(r.optimized, 'Better prompt');
  assert.equal(r.engine, 'openai');
  assert.equal(r.degraded, false);
  assert.match(JSON.parse(calls[0].init.body).messages[1].content, /<raw_prompt>/);
});

test('provider error degrades to offline and carries the provider message', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'bad' }));
  stubFetch(() => jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401));
  const r = await optimizePrompt(RAW);
  assert.equal(r.degraded, true);
  assert.equal(r.engine, 'offline');
  assert.equal(r.requestedEngine, 'openai');
  assert.match(r.degradedReason, /401/);
  assert.match(r.degradedReason, /Incorrect API key/);
});

test('a missing key degrades with a reason that names the key', async () => {
  installChromeStub(settings({ preferredEngine: 'anthropic', anthropicApiKey: '' }));
  const calls = stubFetch(() => jsonResponse({}));
  const r = await optimizePrompt(RAW);
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /API key/i);
  assert.equal(calls.length, 0, 'no request should leave the machine without a key');
});

test('a hung request times out and degrades instead of spinning forever', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  stubFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const r = await optimizePrompt(RAW, { timeoutMs: 40 });
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /timed out/i);
});

test('offline is an explicit choice and is never reported as degraded', async () => {
  installChromeStub(settings({ preferredEngine: 'offline' }));
  const calls = stubFetch(() => jsonResponse({}));
  const r = await optimizePrompt(RAW);
  assert.equal(r.degraded, false);
  assert.equal(r.engine, 'offline');
  assert.equal(calls.length, 0);
});

/* --------------------------------------------------------- offline-first mode */

/* Regression: a removed "offline-first" mode returned the offline template
   after 1.5s and dropped the provider's answer, so cloud engines looked broken.
   A slow provider must still deliver its own rewrite. */
test('a slow provider still returns its own rewrite, not the offline template', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K', openaiModel: 'm' }));
  stubFetch(() => new Promise(resolve => setTimeout(() =>
    resolve(jsonResponse({ choices: [{ message: { content: '```\nLLM optimized prompt\n```' } }] })), 2000)));

  const r = await optimizePrompt(RAW);

  assert.equal(r.engine, 'openai');
  assert.equal(r.degraded, false);
  assert.equal(r.optimized, 'LLM optimized prompt');
});

/* ------------------------------------------------------------------- Nano */

function fakeNano(availability, { output = 'Nano result', record = {} } = {}) {
  globalThis.LanguageModel = {
    availability: async () => availability,
    create: async opts => {
      record.createOpts = opts;
      return {
        prompt: async (text, o) => { record.promptText = text; record.promptOpts = o; return output; },
        destroy() { record.destroyed = true; }
      };
    }
  };
  return record;
}

test('nano: availability "available" is ready; "downloadable" is not', async () => {
  fakeNano('available');
  assert.equal((await checkBuiltInPromptApiStatus()).available, true);
  fakeNano('downloadable');
  const s = await checkBuiltInPromptApiStatus();
  assert.equal(s.available, false);
  assert.equal(s.status, 'downloadable');
});

test('nano: instructions go in initialPrompts (systemPrompt is gone), draft is wrapped', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  const rec = fakeNano('available');
  /* Judge and retry off: this test inspects the rewrite session's own
     parameters, and both would create additional sessions after it. */
  const r = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(r.degraded, false);
  assert.equal(r.engine, 'nano');
  assert.equal(r.optimized, 'Nano result');
  assert.ok(!('systemPrompt' in rec.createOpts), 'removed option must not be sent');
  assert.equal(rec.createOpts.initialPrompts[0].role, 'system');
  assert.match(rec.createOpts.initialPrompts[0].content, /<raw_prompt>/, 'system rule explains the tags');
  assert.match(rec.promptText, /<raw_prompt>/);
  assert.equal(rec.destroyed, true);
});

for (const [state, pattern] of [
  ['downloadable', /download/i],
  ['downloading', /download/i],
  ['unavailable', /unavailable|flags/i]
]) {
  test(`nano: "${state}" degrades with a plain reason`, async () => {
    installChromeStub(settings({ preferredEngine: 'nano' }));
    fakeNano(state);
    const r = await optimizePrompt(RAW);
    assert.equal(r.degraded, true);
    assert.equal(r.requestedEngine, 'nano');
    assert.match(r.degradedReason, pattern);
  });
}

test('nano: no LanguageModel at all degrades as unsupported', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  const r = await optimizePrompt(RAW);
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /not (available|supported)|unsupported/i);
});

test('nano: disabled execution flag calls availability() once and surfaces flag instructions while TypeError still falls back', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  let calls = 0;
  globalThis.LanguageModel = {
    availability: async opts => {
      calls++;
      assert.deepEqual(opts?.expectedInputs, [{ type: 'text', languages: ['en'] }]);
      assert.deepEqual(opts?.expectedOutputs, [{ type: 'text', languages: ['en'] }]);
      const err = new Error('The feature flag gating model execution was disabled.');
      err.name = 'NotSupportedError';
      throw err;
    }
  };
  const status = await checkBuiltInPromptApiStatus();
  assert.equal(calls, 1, 'NotSupportedError must not trigger a second bare availability() call');
  assert.equal(status.available, false);
  assert.equal(status.status, 'error');
  assert.match(status.error, /feature flag gating model execution/i);

  const r = await optimizePrompt(RAW);
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /model execution flag is disabled/i);
  assert.match(r.degradedReason, /#prompt-api-for-gemini-nano/);
  assert.match(r.degradedReason, /#optimization-guide-on-device-model/);

  let fallbackCalls = 0;
  globalThis.LanguageModel = {
    availability: async opts => {
      fallbackCalls++;
      if (opts !== undefined) throw new TypeError('Unsupported options');
      return 'available';
    }
  };
  const legacyStatus = await checkBuiltInPromptApiStatus();
  assert.equal(fallbackCalls, 2);
  assert.equal(legacyStatus.available, true);
});

/* ---------------------------------------------------- connection testing */

test('verifyProvider resolves on success and surfaces the provider message on failure', async () => {
  stubFetch(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
  await verifyProvider('openai', { apiKey: 'K', model: 'm' });

  stubFetch(() => jsonResponse({ error: { message: 'model not found' } }, 404));
  await assert.rejects(
    verifyProvider('openai', { apiKey: 'K', model: 'nope' }),
    /404.*model not found/
  );
});

test('verifyProvider refuses to run without a key', async () => {
  const calls = stubFetch(() => jsonResponse({}));
  await assert.rejects(verifyProvider('gemini', { apiKey: '', model: 'm' }), /key/i);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------ retry logic */

test('sendProviderRequest retries on 429 with Retry-After header', async () => {
  let attempt = 0;
  stubFetch((url, init) => {
    attempt++;
    if (attempt === 1) {
      return jsonResponse({ error: { message: 'rate limited' } }, 429, { 'Retry-After': '1' });
    }
    return jsonResponse({ choices: [{ message: { content: 'Success after retry' } }] });
  });
  const { spec, data } = await sendProviderRequest('openai', { apiKey: 'K', model: 'm', rawPrompt: RAW, systemPrompt: SYSTEM }, 10000);
  assert.equal(attempt, 2);
  assert.equal(spec.extract(data), 'Success after retry');
});

test('sendProviderRequest retries on 500 with exponential backoff', async () => {
  let attempt = 0;
  stubFetch((url, init) => {
    attempt++;
    if (attempt <= 2) {
      return jsonResponse({ error: { message: 'server error' } }, 500);
    }
    return jsonResponse({ choices: [{ message: { content: 'Success after retry' } }] });
  });
  const { spec, data } = await sendProviderRequest('openai', { apiKey: 'K', model: 'm', rawPrompt: RAW, systemPrompt: SYSTEM }, 10000);
  assert.equal(attempt, 3);
  assert.equal(spec.extract(data), 'Success after retry');
});

test('sendProviderRequest gives up after max retries on 500', async () => {
  let attempt = 0;
  stubFetch((url, init) => {
    attempt++;
    return jsonResponse({ error: { message: 'server error' } }, 500);
  });
  await assert.rejects(
    sendProviderRequest('openai', { apiKey: 'K', model: 'm', rawPrompt: RAW, systemPrompt: SYSTEM }, 10000),
    /server error/
  );
  assert.equal(attempt, 4); // initial + 3 retries
});

test('sendProviderRequest does not retry on 400', async () => {
  let attempt = 0;
  stubFetch((url, init) => {
    attempt++;
    return jsonResponse({ error: { message: 'bad request' } }, 400);
  });
  await assert.rejects(
    sendProviderRequest('openai', { apiKey: 'K', model: 'm', rawPrompt: RAW, systemPrompt: SYSTEM }, 10000),
    /bad request/
  );
  assert.equal(attempt, 1); // no retry on 400
});

test('sendProviderRequest retries on network error', async () => {
  let attempt = 0;
  stubFetch((url, init) => {
    attempt++;
    if (attempt === 1) {
      return Promise.reject(new Error('Network error'));
    }
    return jsonResponse({ choices: [{ message: { content: 'Success after retry' } }] });
  });
  const { spec, data } = await sendProviderRequest('openai', { apiKey: 'K', model: 'm', rawPrompt: RAW, systemPrompt: SYSTEM }, 10000);
  assert.equal(attempt, 2);
  assert.equal(spec.extract(data), 'Success after retry');
});

/* ------------------------------------------------------------- fallback */

/* Nano is the default but missing on many machines. A saved provider key
   must be used before the offline template, and the result must say so. */
test('an unavailable Nano falls back to a provider with a saved key', async () => {
  installChromeStub(settings({ preferredEngine: 'nano', openaiApiKey: 'K', openaiModel: 'm' }));
  stubFetch(() => jsonResponse({ choices: [{ message: { content: 'From OpenAI' } }] }));

  const r = await optimizePrompt(RAW);

  assert.equal(r.engine, 'openai');
  assert.equal(r.requestedEngine, 'nano');
  assert.equal(r.degraded, false);
  assert.match(r.fallbackReason, /not supported/);
  assert.equal(r.optimized, 'From OpenAI');
});

test('a failing provider falls back to the next keyed provider, skipping itself', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'BAD', geminiApiKey: 'G' }));
  const calls = stubFetch(url => url.includes('openai.com')
    ? jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401)
    : jsonResponse({ candidates: [{ content: { parts: [{ text: 'From Gemini' }] } }] }));

  const r = await optimizePrompt(RAW);

  assert.equal(r.engine, 'gemini');
  assert.equal(r.requestedEngine, 'openai');
  assert.match(r.fallbackReason, /401/);
  assert.equal(r.optimized, 'From Gemini');
  assert.equal(calls.filter(c => c.url.includes('openai.com')).length, 1, '401 is not retried');
});

test('with no other keyed provider the offline template is used and marked degraded', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  const calls = stubFetch(() => { throw new Error('no provider should be called'); });

  const r = await optimizePrompt(RAW);

  assert.equal(r.engine, 'offline');
  assert.equal(r.degraded, true);
  assert.equal(r.fallbackReason, undefined);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------ OmniRoute */

test('omniroute: supports keyless localhost default, Bearer key, custom baseUrl, and validates URL', () => {
  const keyless = buildProviderRequest('omniroute', {
    systemPrompt: SYSTEM, rawPrompt: RAW
  });
  assert.equal(keyless.url, 'http://localhost:20128/v1/chat/completions');
  assert.ok(!('Authorization' in keyless.init.headers), 'keyless request must not send Authorization header');
  assert.equal(JSON.parse(keyless.init.body).model, 'auto');

  const keyed = buildProviderRequest('omniroute', {
    systemPrompt: SYSTEM,
    rawPrompt: RAW,
    apiKey: ' gw-secret ',
    model: 'auto/coding:free',
    baseUrl: 'http://localhost:20128/custom///'
  });
  assert.equal(keyed.url, 'http://localhost:20128/custom/chat/completions');
  assert.equal(keyed.init.headers.Authorization, 'Bearer gw-secret');
  assert.equal(JSON.parse(keyed.init.body).model, 'auto/coding:free');

  assert.throws(
    () => buildProviderRequest('omniroute', { systemPrompt: SYSTEM, rawPrompt: RAW, baseUrl: 'ftp://invalid' }),
    /Base URL is invalid/i
  );
});

test('omniroute: optimizes keyless when chosen explicitly and participates in fallback only when enabled', async () => {
  installChromeStub(settings({ preferredEngine: 'omniroute', omnirouteEnabled: false, omnirouteApiKey: '' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'Routed output' } }] }));
  const explicit = await optimizePrompt(RAW);
  assert.equal(explicit.engine, 'omniroute');
  assert.equal(explicit.degraded, false);
  assert.equal(explicit.optimized, 'Routed output');
  assert.equal(calls.length, 1);

  installChromeStub(settings({ preferredEngine: 'nano', omnirouteEnabled: false, omnirouteApiKey: '' }));
  const skipped = stubFetch(() => { throw new Error('unconfigured omniroute should not be called as fallback'); });
  const rSkipped = await optimizePrompt(RAW);
  assert.equal(rSkipped.engine, 'offline');
  assert.equal(rSkipped.degraded, true);
  assert.equal(skipped.length, 0);

  installChromeStub(settings({ preferredEngine: 'nano', omnirouteEnabled: true }));
  stubFetch(() => jsonResponse({ choices: [{ message: { content: 'Fallback via gateway' } }] }));
  const rFallback = await optimizePrompt(RAW);
  assert.equal(rFallback.engine, 'omniroute');
  assert.equal(rFallback.requestedEngine, 'nano');
  assert.equal(rFallback.optimized, 'Fallback via gateway');
});

/* --------------------------------------------------- privacy & diagnostics */

test('allowCloudFallback: false keeps Nano strictly offline even with saved cloud keys', async () => {
  installChromeStub(settings({
    preferredEngine: 'nano',
    allowCloudFallback: false,
    openaiApiKey: 'K',
    geminiApiKey: 'G',
    omnirouteEnabled: true
  }));
  const calls = stubFetch(() => { throw new Error('cloud endpoint must not be called'); });

  const r = await optimizePrompt(RAW);

  assert.equal(r.engine, 'offline');
  assert.equal(r.requestedEngine, 'nano');
  assert.equal(r.degraded, true);
  assert.equal(calls.length, 0);
});

test('sendProviderRequest handles HTTP-date Retry-After header and Gemini block/finish diagnostics', async () => {
  let attempt = 0;
  stubFetch(() => {
    attempt++;
    if (attempt === 1) {
      const soon = new Date(Date.now() + 60).toUTCString();
      return jsonResponse({ error: { message: 'rate limited' } }, 429, { 'Retry-After': soon });
    }
    return jsonResponse({ choices: [{ message: { content: 'Recovered via HTTP-date' } }] });
  });
  const ok = await sendProviderRequest('openai', {
    apiKey: 'K', model: 'm', rawPrompt: RAW, systemPrompt: SYSTEM
  }, 5000);
  assert.equal(attempt, 2);
  assert.equal(ok.spec.extract(ok.data), 'Recovered via HTTP-date');

  installChromeStub(settings({ preferredEngine: 'gemini', geminiApiKey: 'G' }));
  stubFetch(() => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
  const blocked = await optimizePrompt(RAW);
  assert.equal(blocked.degraded, true);
  assert.match(blocked.degradedReason, /blocked the request \(SAFETY\)/i);

  stubFetch(() => jsonResponse({ candidates: [{ finishReason: 'RECITATION' }] }));
  const stopped = await optimizePrompt(RAW);
  assert.equal(stopped.degraded, true);
  assert.match(stopped.degradedReason, /stopped early \(RECITATION\)/i);
});

/* ----------------------------------------------------------- Nano quota */

test('nano: trims oversized page_context to fit inputQuota and turns QuotaExceededError into a clear message', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  const seenPrompts = [];
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      inputQuota: 500,
      measureInputUsage: async msg => msg.length,
      prompt: async msg => {
        seenPrompts.push(msg);
        return 'Act as an engineer. Context: trimmed. Format: Markdown. Verify assumptions. Requirements:\n1. Handle edge cases.';
      },
      destroy() {}
    })
  };
  const r = await optimizePrompt(RAW, { context: 'A'.repeat(1200), nanoJudge: false, scoreRetry: false });
  assert.equal(r.degraded, false);
  assert.ok(seenPrompts[0].length <= 425, `prompt length ${seenPrompts[0].length} should fit inside safe budget`);

  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async () => {
        const err = new Error('Too big');
        err.name = 'QuotaExceededError';
        throw err;
      },
      destroy() {}
    })
  };
  const quotaErr = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(quotaErr.degraded, true);
  assert.match(quotaErr.degradedReason, /on-device context limit/i);
});

/* ----------------------------------------------------- ordered fallback chain */

test('same-provider fallback retries the same engine with Fallback 1 model override', async () => {
  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    openaiModel: 'gpt-4.1',
    fallback1Engine: 'openai',
    fallback1Model: 'gpt-4o-mini'
  }));
  const calls = stubFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'gpt-4.1') {
      return jsonResponse({ error: { message: 'model overloaded' } }, 404);
    }
    return jsonResponse({ choices: [{ message: { content: 'Fallback model output' } }] });
  });
  const starts = [];
  const r = await optimizePrompt(RAW, {
    nanoJudge: false,
    scoreRetry: false,
    onStart: (engine, model) => starts.push([engine, model])
  });

  assert.equal(r.degraded, false);
  assert.equal(r.engine, 'openai');
  assert.equal(r.model, 'gpt-4o-mini');
  assert.equal(r.requestedEngine, 'openai');
  assert.equal(r.requestedModel, 'gpt-4.1');
  assert.match(r.fallbackReason, /404/);
  assert.deepEqual(calls.map(c => JSON.parse(c.init.body).model), ['gpt-4.1', 'gpt-4o-mini']);
  assert.deepEqual(starts, [['openai', 'gpt-4.1'], ['openai', 'gpt-4o-mini']]);
});

test('fallback chain deduplicates identical (engine, model) slots and skips seenEngines in auto-fallback', async () => {
  // Exact duplicate (openai, gpt-4.1) in Fallback 1 is skipped before Fallback 2 (gemini).
  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    openaiModel: 'gpt-4.1',
    fallback1Engine: 'openai',
    fallback1Model: 'gpt-4.1',
    fallback2Engine: 'gemini',
    fallback2Model: 'gemini-2.5-pro',
    geminiApiKey: 'G',
    anthropicApiKey: 'A'
  }));
  const calls = stubFetch(url => {
    if (url.includes('api.openai.com')) {
      return jsonResponse({ error: { message: 'openai down' } }, 404);
    }
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'From Gemini 2.5 Pro' }] } }] });
  });
  const r1 = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(r1.engine, 'gemini');
  assert.equal(r1.model, 'gemini-2.5-pro');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('api.openai.com'));
  assert.ok(calls[1].url.includes('gemini-2.5-pro'));

  // Same-provider fallback fails on alternate model: auto-fallback tries keyed Gemini once, never retries OpenAI.
  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    openaiModel: 'gpt-4.1',
    fallback1Engine: 'openai',
    fallback1Model: 'gpt-4o-mini',
    geminiApiKey: 'G'
  }));
  const calls2 = stubFetch(url => {
    if (url.includes('api.openai.com')) {
      return jsonResponse({ error: { message: 'openai rejected' } }, 404);
    }
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Auto Gemini output' }] } }] });
  });
  const r2 = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(r2.engine, 'gemini');
  assert.deepEqual(
    calls2.map(c => (c.url.includes('api.openai.com') ? JSON.parse(c.init.body).model : 'gemini')),
    ['gpt-4.1', 'gpt-4o-mini', 'gemini']
  );
});

test('cross-provider Fallback 1 -> Fallback 2 order overrides PROVIDERS declaration order', async () => {
  installChromeStub(settings({
    preferredEngine: 'gemini',
    geminiApiKey: 'G',
    openaiApiKey: 'O',
    anthropicApiKey: 'A',
    fallback1Engine: 'anthropic',
    fallback1Model: 'claude-sonnet-4-6',
    fallback2Engine: 'openai',
    fallback2Model: 'gpt-4o-mini'
  }));
  const calls = stubFetch(url => {
    if (url.includes('generativelanguage.googleapis.com') || url.includes('api.anthropic.com')) {
      return jsonResponse({ error: { message: 'nope' } }, 404);
    }
    return jsonResponse({ choices: [{ message: { content: 'OpenAI second fallback won' } }] });
  });
  const r = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(r.engine, 'openai');
  assert.equal(r.model, 'gpt-4o-mini');
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes('generativelanguage.googleapis.com'));
  assert.ok(calls[1].url.includes('api.anthropic.com'));
  assert.equal(JSON.parse(calls[1].init.body).model, 'claude-sonnet-4-6');
  assert.ok(calls[2].url.includes('api.openai.com'));
  assert.equal(JSON.parse(calls[2].init.body).model, 'gpt-4o-mini');
});

test('offline circuit breaker in Fallback 1 or Fallback 2 halts later slots and auto-fallback', async () => {
  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    geminiApiKey: 'G',
    anthropicApiKey: 'A',
    fallback1Engine: 'offline',
    fallback2Engine: 'anthropic'
  }));
  const calls1 = stubFetch(() => jsonResponse({ error: { message: 'bad model' } }, 404));
  const r1 = await optimizePrompt(RAW);
  assert.equal(r1.engine, 'offline');
  assert.equal(r1.degraded, true);
  assert.equal(calls1.length, 1);

  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    geminiApiKey: 'G',
    anthropicApiKey: 'A',
    fallback1Engine: 'anthropic',
    fallback2Engine: 'offline'
  }));
  const calls2 = stubFetch(() => jsonResponse({ error: { message: 'bad model' } }, 404));
  const r2 = await optimizePrompt(RAW);
  assert.equal(r2.engine, 'offline');
  assert.equal(r2.degraded, true);
  assert.equal(calls2.length, 2);
  assert.ok(calls2[0].url.includes('api.openai.com'));
  assert.ok(calls2[1].url.includes('api.anthropic.com'));
});

test('explicit OmniRoute slot runs keyless when disabled and allowCloudFallback blocks cloud while keeping localhost', async () => {
  // Explicit remote OmniRoute works even when omnirouteEnabled: false and keyless.
  installChromeStub(settings({
    preferredEngine: 'nano',
    allowCloudFallback: true,
    omnirouteEnabled: false,
    omnirouteBaseUrl: 'https://gateway.example.com/v1',
    fallback1Engine: 'omniroute',
    fallback1Model: 'auto/coding:free'
  }));
  const calls1 = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'OmniRoute gateway response' } }] }));
  const r1 = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(r1.degraded, false);
  assert.equal(r1.engine, 'omniroute');
  assert.equal(r1.model, 'auto/coding:free');
  assert.equal(calls1.length, 1);
  assert.equal(calls1[0].url, 'https://gateway.example.com/v1/chat/completions');
  assert.equal(JSON.parse(calls1[0].init.body).model, 'auto/coding:free');

  // allowCloudFallback: false from Nano skips cloud Fallback 1 but allows local OmniRoute Fallback 2.
  installChromeStub(settings({
    preferredEngine: 'nano',
    allowCloudFallback: false,
    openaiApiKey: 'K',
    omnirouteBaseUrl: 'http://localhost:20128/v1',
    omnirouteModel: 'auto',
    fallback1Engine: 'openai',
    fallback1Model: 'gpt-4o-mini',
    fallback2Engine: 'omniroute',
    fallback2Model: 'auto/fast:free'
  }));
  const calls2 = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'Local OmniRoute fallback' } }] }));
  const r2 = await optimizePrompt(RAW, { nanoJudge: false, scoreRetry: false });
  assert.equal(r2.degraded, false);
  assert.equal(r2.engine, 'omniroute');
  assert.equal(r2.model, 'auto/fast:free');
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].url, 'http://localhost:20128/v1/chat/completions');

  // allowCloudFallback: false from Nano skips explicit remote OmniRoute fallback too.
  installChromeStub(settings({
    preferredEngine: 'nano',
    allowCloudFallback: false,
    omnirouteBaseUrl: 'https://remote.example.com/v1',
    fallback1Engine: 'omniroute',
    fallback1Model: 'auto'
  }));
  const calls3 = stubFetch(() => { throw new Error('remote endpoint must not be called'); });
  const r3 = await optimizePrompt(RAW);
  assert.equal(r3.degraded, true);
  assert.equal(r3.engine, 'offline');
  assert.equal(calls3.length, 0);
});

test('refinePrompt, clarifyPrompt, and scoreRetry preserve fallback model overrides', async () => {
  // refinePrompt
  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    openaiModel: 'gpt-4.1',
    fallback1Engine: 'openai',
    fallback1Model: 'gpt-4o-mini'
  }));
  stubFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'gpt-4.1') return jsonResponse({ error: { message: 'failed' } }, 404);
    return jsonResponse({ choices: [{ message: { content: 'Tighter prompt' } }] });
  });
  const ref = await refinePrompt(RAW, { kind: 'shorter', previous: 'Long draft prompt to tighten.' });
  assert.equal(ref.engine, 'openai');
  assert.equal(ref.model, 'gpt-4o-mini');
  assert.equal(ref.requestedModel, 'gpt-4.1');
  assert.match(ref.fallbackReason, /404/);

  // clarifyPrompt
  installChromeStub(settings({
    preferredEngine: 'openai',
    openaiApiKey: 'K',
    openaiModel: 'gpt-4.1',
    anthropicApiKey: 'A',
    fallback1Engine: 'anthropic',
    fallback1Model: 'claude-haiku-4-5'
  }));
  stubFetch(url => {
    if (url.includes('api.openai.com')) return jsonResponse({ error: { message: 'down' } }, 404);
    return jsonResponse({ content: [{ text: 'Who is the audience?\nWhat stack should it use?' }] });
  });
  const clar = await clarifyPrompt(RAW);
  assert.equal(clar.engine, 'anthropic');
  assert.equal(clar.model, 'claude-haiku-4-5');
  assert.equal(clar.requestedModel, 'gpt-4.1');
  assert.equal(clar.questions.length, 2);

  // optimizePrompt with scoreRetry: true retains Fallback 1 model on the quality retry
  installChromeStub(settings({
    preferredEngine: 'gemini',
    geminiApiKey: 'G',
    openaiApiKey: 'K',
    openaiModel: 'gpt-4.1',
    fallback1Engine: 'openai',
    fallback1Model: 'gpt-4o-mini'
  }));
  let openAiAttempt = 0;
  const retryCalls = stubFetch(url => {
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({ error: { message: 'gemini unavailable' } }, 404);
    }
    openAiAttempt++;
    if (openAiAttempt === 1) {
      return jsonResponse({ choices: [{ message: { content: 'Make a site.' } }] });
    }
    return jsonResponse({
      choices: [{
        message: {
          content: 'Act as a senior frontend engineer.\nContext: Modern responsive portfolio.\nRequirements:\n1. Use semantic HTML.\n2. Output production code and verify accessibility.'
        }
      }]
    });
  });
  const retryStarts = [];
  const retried = await optimizePrompt(RAW, {
    nanoJudge: false,
    scoreRetry: true,
    onToken: () => {},
    onStart: (e, m) => retryStarts.push([e, m])
  });
  assert.equal(retried.engine, 'openai');
  assert.equal(retried.model, 'gpt-4o-mini');
  assert.equal(openAiAttempt, 2);
  assert.deepEqual(
    retryCalls.filter(c => c.url.includes('api.openai.com')).map(c => JSON.parse(c.init.body).model),
    ['gpt-4o-mini', 'gpt-4o-mini']
  );
  assert.deepEqual(retryStarts, [
    ['gemini', 'gemini-3.5-flash-lite'],
    ['openai', 'gpt-4o-mini'],
    ['openai', 'gpt-4o-mini']
  ]);
});

/* --------------------------------------------------- repairPrompt & guards */

test('hasStructuredTokens detects composer references while ignoring URLs, emails, and file paths', () => {
  assert.equal(MAX_QUICK_ENHANCE_CHARS, 8000);
  assert.equal(REPAIR_MAX_CHARS, 2000);
  assert.equal(hasStructuredTokens('check @file:src/index.ts for bugs'), true);
  assert.equal(hasStructuredTokens('ask @alice to review'), true);
  assert.equal(hasStructuredTokens('inspect (@src/app.ts)'), true);
  assert.equal(hasStructuredTokens('/review this diff'), true);
  assert.equal(hasStructuredTokens('run (/plan) next'), true);

  assert.equal(hasStructuredTokens('email user@example.com about https://example.com/docs/v1'), false);
  assert.equal(hasStructuredTokens('edit /usr/local/bin/node or a/b toggle'), false);
});

test('isRepairAcceptable permits small repairs and rejects empty, identical, or over-expanded outputs', () => {
  assert.equal(isRepairAcceptable('helo wrld', 'hello world'), true);
  assert.equal(isRepairAcceptable('hello world', 'hello world'), false);
  assert.equal(isRepairAcceptable('hello world', ''), false);
  assert.equal(
    isRepairAcceptable('wrte a tst', 'Please write a comprehensive integration test suite covering edge cases.'),
    false
  );
  const hundred = 'a'.repeat(100);
  assert.equal(isRepairAcceptable(hundred, 'a'.repeat(115)), true);
  assert.equal(isRepairAcceptable(hundred, 'a'.repeat(120)), false);
});

test('repairPrompt skips > 2000 chars, structured tokens, and offline; degrades safely; and rethrows cancel', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));

  const tooLong = await repairPrompt('x'.repeat(2001));
  assert.equal(tooLong.changed, false);
  assert.equal(tooLong.skipped, 'too_long');

  const withMention = await repairPrompt('fix bug in @src/auth.ts');
  assert.equal(withMention.changed, false);
  assert.equal(withMention.skipped, 'structured_tokens');

  const offlineRes = await repairPrompt('wrte a tst', { engine: 'offline' });
  assert.equal(offlineRes.changed, false);
  assert.equal(offlineRes.skipped, 'offline');

  // Accepts clean repair and passes onStatus retry events
  let attempt = 0;
  stubFetch(() => {
    attempt++;
    if (attempt === 1) {
      return jsonResponse({ error: { message: 'rate limit' } }, 429, { 'Retry-After': '0.01' });
    }
    return jsonResponse({ choices: [{ message: { content: 'Write a test for login.' } }] });
  });
  const statuses = [];
  const repaired = await repairPrompt('wrte a test for lgoin', { onStatus: s => statuses.push(s) });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.repaired, 'Write a test for login.');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status, 429);

  // Rejects over-rewrite drift without blocking caller
  stubFetch(() => jsonResponse({
    choices: [{ message: { content: 'Here is a dramatically expanded multi-paragraph prompt specification that rewrites everything completely.' } }]
  }));
  const driftRejected = await repairPrompt('wrte a test');
  assert.equal(driftRejected.changed, false);
  assert.equal(driftRejected.skipped, 'drift_rejected');
  assert.equal(driftRejected.repaired, 'wrte a test');

  // Non-blocking error fallback
  stubFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
  const errored = await repairPrompt('wrte a test');
  assert.equal(errored.changed, false);
  assert.equal(errored.skipped, 'error');
  assert.equal(errored.repaired, 'wrte a test');

  // Cancellation rethrows CancelledError instead of masking as unchanged
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(repairPrompt('wrte a test', { signal: ctl.signal }), CancelledError);
});
