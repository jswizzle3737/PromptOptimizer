import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, stubFetch, jsonResponse } from './helpers.mjs';
import {
  optimizePrompt, buildUserMessage, buildProviderRequest, cleanModelOutput,
  verifyProvider, checkBuiltInPromptApiStatus, escapeRawPromptTags, sendProviderRequest
} from '../shared/optimizer-engine.js';

const SYSTEM = 'You rewrite prompts.';
const RAW = 'make me a website';

function settings(extra = {}) {
  return { promptcraft_settings: { schemaVersion: 3, ...extra } };
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
