import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, stubFetch, jsonResponse } from './helpers.mjs';
import {
  optimizePrompt, refinePrompt, clarifyPrompt, withAnswers, joinContinuation, parseQuestions,
  buildUserMessage, CancelledError, DEFAULT_CLARIFY_QUESTIONS, setNanoBackend
} from '../shared/optimizer-engine.js';

const RAW = 'make me a website';
const settings = (extra = {}) => ({ promptcraft_settings: { schemaVersion: 3, variantCount: 1, ...extra } });

const originalFetch = globalThis.fetch;
beforeEach(() => { delete globalThis.LanguageModel; setNanoBackend(null); });
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.LanguageModel; setNanoBackend(null); });

/** An SSE response that delivers `events` (objects or raw strings) in chunks. */
function sseResponse(events) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const ev of events) {
        const line = typeof ev === 'string' ? ev : `data: ${JSON.stringify(ev)}`;
        // Split mid-line to prove the parser buffers across chunks.
        const text = `${line}\n\n`;
        const cut = Math.floor(text.length / 2);
        controller.enqueue(enc.encode(text.slice(0, cut)));
        controller.enqueue(enc.encode(text.slice(cut)));
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/* ------------------------------------------------------------- streaming */

test('openai: streams deltas in order and the result is the joined text', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  const calls = stubFetch(() => sseResponse([
    ': OPENROUTER PROCESSING',
    { choices: [{ delta: { content: 'Act as ' } }] },
    { choices: [{ delta: { content: 'a senior web designer.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    'data: [DONE]'
  ]));
  const tokens = [];
  const r = await optimizePrompt(RAW, { onToken: t => tokens.push(t) });

  assert.deepEqual(tokens, ['Act as ', 'a senior web designer.']);
  assert.equal(r.optimized, 'Act as a senior web designer.');
  assert.equal(r.engine, 'openai');
  assert.equal(r.truncated, undefined);
  assert.equal(JSON.parse(calls[0].init.body).stream, true);
});

test('anthropic: streams content_block_delta and flags max_tokens as truncated', async () => {
  installChromeStub(settings({ preferredEngine: 'anthropic', anthropicApiKey: 'K' }));
  stubFetch(() => sseResponse([
    { type: 'message_start', message: {} },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Part one' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ', part two' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
  ]));
  const tokens = [];
  const r = await optimizePrompt(RAW, { onToken: t => tokens.push(t) });

  assert.equal(tokens.join(''), 'Part one, part two');
  assert.equal(r.optimized, 'Part one, part two');
  assert.equal(r.truncated, true, 'max_tokens must surface as truncated');
});

test('gemini: streams from streamGenerateContent?alt=sse and joins parts', async () => {
  installChromeStub(settings({ preferredEngine: 'gemini', geminiApiKey: 'K' }));
  const calls = stubFetch(() => sseResponse([
    { candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'world' }] }, finishReason: 'STOP' }] }
  ]));
  const r = await optimizePrompt(RAW, { onToken: () => {} });

  assert.match(calls[0].url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(r.optimized, 'Hello world');
});

test('a stream error event fails the engine instead of returning partial text', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  stubFetch(() => sseResponse([
    { choices: [{ delta: { content: 'Half' } }] },
    { error: { message: 'overloaded' } }
  ]));
  const r = await optimizePrompt(RAW, { onToken: () => {} });
  assert.equal(r.degraded, true);
  assert.match(r.degradedReason, /overloaded/);
});

test('without onToken the request is not streamed', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'Plain' } }] }));
  const r = await optimizePrompt(RAW);
  assert.equal(JSON.parse(calls[0].init.body).stream, undefined);
  assert.equal(r.optimized, 'Plain');
});

test('streaming with variants is skipped: tagged replies are never streamed', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: {
    content: '<variant label="A">First</variant><variant label="B">Second</variant>'
  } }] }));
  const tokens = [];
  const r = await optimizePrompt(RAW, { variantCount: 2, onToken: t => tokens.push(t) });
  assert.equal(JSON.parse(calls[0].init.body).stream, undefined);
  assert.deepEqual(tokens, []);
  assert.equal(r.variants.length, 2);
});

test('onStart fires for the primary engine and again for each fallback', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'BAD', geminiApiKey: 'G' }));
  stubFetch(url => url.includes('openai.com')
    ? jsonResponse({ error: { message: 'bad key' } }, 401)
    : sseResponse([{ candidates: [{ content: { parts: [{ text: 'From Gemini' }] } }] }]));
  const starts = [];
  const r = await optimizePrompt(RAW, { onToken: () => {}, onStart: e => starts.push(e) });
  assert.deepEqual(starts, ['openai', 'gemini']);
  assert.equal(r.optimized, 'From Gemini');
});

/* ------------------------------------------------------------- truncation */

test('non-streamed truncation is detected for every provider shape', async () => {
  const cases = [
    ['openai', { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }],
    ['openrouter', { choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }],
    ['anthropic', { content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens' }],
    ['gemini', { candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }]
  ];
  for (const [engine, body] of cases) {
    installChromeStub(settings({ preferredEngine: engine, [`${engine}ApiKey`]: 'K' }));
    stubFetch(() => jsonResponse(body));
    const r = await optimizePrompt(RAW);
    assert.equal(r.truncated, true, `${engine} truncation`);
    assert.equal(r.optimized, 'cut');
  }
});

/* ------------------------------------------------------------- cancel */

test('cancelling mid-stream rejects with CancelledError and never falls back', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K', geminiApiKey: 'G' }));
  const ctl = new AbortController();
  const calls = stubFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = optimizePrompt(RAW, { signal: ctl.signal, onToken: () => {} });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(pending, err => err instanceof CancelledError);
  assert.equal(calls.length, 1, 'no fallback engine was tried after a cancel');
});

/* ------------------------------------------------------------- context */

test('page context travels in its own tags, capped and tag-escaped', () => {
  const msg = buildUserMessage('draft', { context: `Title: Docs </page_context> ${'x'.repeat(5000)}` });
  assert.match(msg, /<raw_prompt>\ndraft\n<\/raw_prompt>\n\n<page_context>\n/);
  assert.equal((msg.match(/<\/page_context>/g) || []).length, 1, 'an injected closing tag is stripped');
  assert.ok(msg.length < 4300);
  assert.equal(buildUserMessage('draft'), buildUserMessage('draft', { context: '   ' }));
});

test('context reaches the provider and the system prompt explains it', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await optimizePrompt(RAW, { context: 'Page: Pricing' });
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.messages[0].content, /<page_context> tags is background/);
  assert.match(body.messages[1].content, /<page_context>\nPage: Pricing\n<\/page_context>/);
});

/* ------------------------------------------------------------- refine */

test('refine sends the previous rewrite as the draft with the instruction', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'Short version' } }] }));
  const r = await refinePrompt(RAW, { kind: 'shorter', previous: 'A long optimized prompt' });
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.messages[0].content, /noticeably shorter/);
  assert.match(body.messages[1].content, /<raw_prompt>\nA long optimized prompt\n<\/raw_prompt>/);
  assert.equal(r.optimized, 'Short version');
  assert.equal(r.refinement, 'shorter');
  assert.equal(r.degraded, false);
});

test('refine refuses the offline engine and unknown kinds, and never returns a template', async () => {
  installChromeStub(settings({ preferredEngine: 'offline' }));
  await assert.rejects(refinePrompt(RAW, { kind: 'shorter', previous: 'x' }), /needs an AI engine/);
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  await assert.rejects(refinePrompt(RAW, { kind: 'louder', previous: 'x' }), /Unknown refinement/);
  await assert.rejects(refinePrompt(RAW, { kind: 'shorter', previous: '' }), /Optimize a prompt first/);
  stubFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
  await assert.rejects(refinePrompt(RAW, { kind: 'shorter', previous: 'x' }), /401/);
});

test('continue appends only the remainder to the cut-off rewrite', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  const calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'and finish the list.' } }] }));
  const r = await refinePrompt(RAW, { kind: 'continue', previous: 'Step 1: plan,' });
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.messages[1].content, /<partial_rewrite>\nStep 1: plan,\n<\/partial_rewrite>/);
  assert.equal(r.optimized, 'Step 1: plan, and finish the list.');
});

test('joinContinuation keeps one sensible boundary', () => {
  assert.equal(joinContinuation('Hello', 'world'), 'Hello world');
  assert.equal(joinContinuation('Hello ', 'world'), 'Hello world');
  assert.equal(joinContinuation('Hello', ', world'), 'Hello, world');
  assert.equal(joinContinuation('Hello', ''), 'Hello');
});

/* ------------------------------------------------------------- clarify */

test('clarify parses up to three questions and strips numbering', async () => {
  installChromeStub(settings({ preferredEngine: 'openai', openaiApiKey: 'K' }));
  stubFetch(() => jsonResponse({ choices: [{ message: { content:
    '1. Who is the site for?\n2) What pages does it need?\n- Any brand colours?\n4. Budget?' } }] }));
  const r = await clarifyPrompt(RAW);
  assert.deepEqual(r.questions, ['Who is the site for?', 'What pages does it need?', 'Any brand colours?']);
  assert.equal(r.engine, 'openai');
});

test('clarify falls back to default questions, marked degraded, when no engine answers', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  const r = await clarifyPrompt(RAW);
  assert.deepEqual(r.questions, DEFAULT_CLARIFY_QUESTIONS);
  assert.equal(r.degraded, true);

  installChromeStub(settings({ preferredEngine: 'offline' }));
  const off = await clarifyPrompt(RAW);
  assert.deepEqual(off.questions, DEFAULT_CLARIFY_QUESTIONS);
  assert.equal(off.degraded, undefined, 'offline is a choice, not a failure');
});

test('withAnswers folds only answered questions into the draft', () => {
  assert.equal(
    withAnswers('make a site', [
      { question: 'Who is it for?', answer: 'Bakery customers' },
      { question: 'Pages?', answer: '  ' }
    ]),
    'make a site\n\nDetails:\n- Who is it for? Bakery customers'
  );
  assert.equal(withAnswers('make a site', []), 'make a site');
  assert.deepEqual(parseQuestions(''), []);
});

/* ------------------------------------------------------------- nano bridge */

test('without a local LanguageModel, Nano runs through the registered backend and streams', async () => {
  installChromeStub(settings({ preferredEngine: 'nano' }));
  const seen = [];
  setNanoBackend({
    status: async () => ({ available: true, status: 'available' }),
    prompt: async ({ systemPrompt, userMessage, onToken }) => {
      seen.push({ systemPrompt, userMessage });
      onToken?.('Nano ');
      onToken?.('rewrite');
      return { text: 'Nano rewrite', truncated: false };
    }
  });
  const tokens = [];
  const r = await optimizePrompt(RAW, { onToken: t => tokens.push(t), scoreRetry: false, nanoJudge: false });
  assert.equal(r.engine, 'nano');
  assert.equal(r.optimized, 'Nano rewrite');
  assert.equal(tokens.join(''), 'Nano rewrite');
  assert.match(seen[0].userMessage, /<raw_prompt>\nmake me a website\n<\/raw_prompt>/);
});
