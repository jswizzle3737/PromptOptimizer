import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers.mjs';
import {
  scorePrompt, judgeWithNano, contractTraitIds, rankVariants, SCORING_TRAITS
} from '../shared/scorer.js';
import { generateOfflineOptimization, DEFAULT_FRAMEWORKS } from '../shared/frameworks.js';
import { optimizePrompt } from '../shared/optimizer-engine.js';

const originalChrome = globalThis.chrome;
const originalLanguageModel = globalThis.LanguageModel;

beforeEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.LanguageModel = originalLanguageModel;
});
afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.LanguageModel = originalLanguageModel;
});

/* Fixed corpus: the raw prompts every offline output must beat. This is the
   prompt-quality contract — extend the corpus, and a regression here means a
   template or rubric change broke the promise, not just a unit. */
const CORPUS = [
  'write a python script to parse csv files',
  'draft an email to my landlord about the heater',
  'analyze last quarter churn metrics',
  'plan a team offsite',
  'explain goroutines to me'
];

function offlineSettings() {
  installChromeStub({ promptcraft_settings: { schemaVersion: 3, preferredEngine: 'offline' } });
}

/* ------------------------------------------------------------ rubric */

test('the rubric is bounded and deterministic', () => {
  const text = 'Act as a Principal Engineer. Context: the csv export needs cleaning. Output format: markdown. Requirements:\n1. Address edge cases. Verify assumptions. Success criteria: immediately actionable.';
  const a = scorePrompt(text);
  const b = scorePrompt(text);
  assert.deepEqual(a, b, 'same input must score identically');
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.equal(a.score, 100, 'a text containing every trait scores 100');
  assert.equal(a.missed.length, 0);
});

test('a raw one-liner scores low; a structured rewrite scores high', () => {
  const raw = scorePrompt('write a python script to parse csv files');
  const optimized = scorePrompt(
    'Context: parse the csv export the finance team uploads.\n\n' +
    'Act as a Principal Software Engineer.\n\nRequirements & Constraints:\n1. Provide an in-depth solution.\n2. Address edge cases.\n\nDeliverable Format:\n- Markdown headings.\n- Verify assumptions before concluding.\n- Success criteria: immediately actionable.'
  );
  assert.ok(raw.score <= 30, `raw scored ${raw.score}`);
  assert.equal(optimized.score, 100);
  assert.ok(raw.score < optimized.score);
});

test('hit and missed report the weighted traits', () => {
  const r = scorePrompt('Act as a data analyst.', { traitIds: ['role', 'format'] });
  assert.equal(r.score, 50);
  assert.deepEqual(r.hit.map(t => t.id), ['role']);
  assert.deepEqual(r.missed.map(t => t.id), ['format']);
});

test('an empty contract yields no score rather than a fake 100', () => {
  const r = scorePrompt('anything', { traitIds: [] });
  assert.equal(r.score, null);
});

/* --------------------------------------------- framework contracts */

test('contractTraitIds maps framework techniques to rubric traits', () => {
  assert.deepEqual(contractTraitIds('smart-expand'), ['role', 'constraints', 'format']);
  assert.deepEqual(contractTraitIds('concise'), ['format'], 'brevity has no text test and is dropped');
  assert.equal(contractTraitIds('not-a-framework'), null, 'custom frameworks get the full rubric');
});

test('CONTRACT: every default framework\'s offline output scores 100 against its own contract', () => {
  for (const raw of CORPUS) {
    for (const fw of DEFAULT_FRAMEWORKS) {
      const out = generateOfflineOptimization(raw, fw.id, DEFAULT_FRAMEWORKS);
      const s = scorePrompt(out, { traitIds: contractTraitIds(fw.id) });
      assert.equal(
        s.score, 100,
        `${fw.id} missed [${s.missed.map(t => t.label).join(', ')}] for: "${raw}"`
      );
    }
  }
});

test('CONTRACT: every offline output beats its raw draft', () => {
  for (const raw of CORPUS) {
    const before = scorePrompt(raw).score;
    for (const fw of DEFAULT_FRAMEWORKS) {
      const out = generateOfflineOptimization(raw, fw.id, DEFAULT_FRAMEWORKS);
      const after = scorePrompt(out, { traitIds: contractTraitIds(fw.id) }).score;
      assert.ok(before < after, `${fw.id}: before ${before} !< after ${after}`);
    }
  }
});

/* --------------------------------------------------------- nano judge */

function fakeJudgeQueue(replies) {
  let call = 0;
  const record = { prompts: [], destroyed: 0, created: 0 };
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => {
      record.created++;
      return {
        prompt: async text => {
          record.prompts.push(text);
          return replies[Math.min(call++, replies.length - 1)];
        },
        destroy() { record.destroyed++; }
      };
    }
  };
  return record;
}

test('judgeWithNano parses a well-formed verdict', async () => {
  fakeJudgeQueue(['{"score": 88, "note": "solid"}']);
  const r = await judgeWithNano('draft', 'Act as an expert. Output format: markdown.');
  assert.deepEqual(r, { score: 88 });
});

test('judgeWithNano degrades to null on any failure, and always destroys the session', async () => {
  let record = fakeJudgeQueue(['banana — no json here']);
  assert.equal(await judgeWithNano('d', 'r'), null, 'unparseable reply');
  assert.equal(record.destroyed, 1);

  record = fakeJudgeQueue(['{"score": 999}']);
  assert.deepEqual(await judgeWithNano('d', 'r'), { score: 100 }, 'an out-of-range verdict clamps, not rejects');

  record = fakeJudgeQueue(['{"score": 42}']);
  globalThis.LanguageModel.availability = async () => 'downloadable';
  assert.equal(await judgeWithNano('d', 'r'), null, 'model not available');
  assert.equal(record.created, 0, 'no session is created when unavailable');

  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => { throw new Error('boom'); }
  };
  assert.equal(await judgeWithNano('d', 'r'), null, 'create() throwing');
});

/* ------------------------------------------------------ variant ranking */

test('rankVariants sorts best-first and breaks ties deterministically', () => {
  const ranked = rankVariants([
    { label: 'B', text: 'b', score: 70 },
    { label: 'A', text: 'a', score: 90 },
    { label: 'C', text: 'c', score: 70 }
  ]);
  assert.deepEqual(ranked.map(v => v.label), ['A', 'B', 'C']);
  assert.deepEqual(rankVariants([]), []);
});

/* ------------------------------------------------ offline integration */

test('optimizePrompt offline attaches a before/after score and no variants by default', async () => {
  offlineSettings();
  const r = await optimizePrompt(CORPUS[0], { engine: 'offline' });
  assert.equal(r.engine, 'offline');
  assert.deepEqual(r.variants, []);
  assert.equal(r.score.method, 'rules');
  assert.equal(r.score.after, 100);
  assert.ok(r.score.before < r.score.after);
});

test('offline variants keep the requested framework primary and rank the rest', async () => {
  offlineSettings();
  const r = await optimizePrompt(CORPUS[3], { engine: 'offline', frameworkId: 'rtf', variantCount: 3 });
  assert.equal(r.variants.length, 3, 'three variants requested');
  assert.equal(r.variants[0].framework, 'rtf', 'the picked framework stays primary');
  assert.equal(r.optimized, r.variants[0].text);
  for (const v of r.variants) {
    assert.ok(typeof v.score === 'number' && v.score >= 90, `variant "${v.label}" scored ${v.score}`);
    assert.ok(v.text.includes(CORPUS[3]), 'variants address the draft');
  }
  const rest = r.variants.slice(1).map(v => v.score);
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a), 'alternatives are ranked best-first');
});

test('variantCount is clamped to 1-3', async () => {
  offlineSettings();
  const high = await optimizePrompt(CORPUS[0], { engine: 'offline', variantCount: 9 });
  assert.equal(high.variants.length, 3);
  const zero = await optimizePrompt(CORPUS[0], { engine: 'offline', variantCount: 0 });
  assert.deepEqual(zero.variants, []);
  const junk = await optimizePrompt(CORPUS[0], { engine: 'offline', variantCount: 'two' });
  assert.deepEqual(junk.variants, []);
});

/* ------------------------------------------------- nano scoring + retry */

function fakeNanoQueue(outputs) {
  let call = 0;
  const record = { created: 0, prompts: [], destroyed: 0 };
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => {
      record.created++;
      return {
        prompt: async text => {
          record.prompts.push(text);
          return outputs[Math.min(call++, outputs.length - 1)];
        },
        destroy() { record.destroyed++; }
      };
    }
  };
  return record;
}

const GOOD_REWRITE =
  'Act as a Principal Software Engineer and System Architect.\n\n' +
  '**Objective:**\nfix the bug\n\n' +
  '**Requirements & Constraints:**\n1. Provide an in-depth solution.\n' +
  '2. Address edge cases and potential failure modes.\n\n' +
  '**Deliverable Format:**\n- Structure with clear Markdown headers.';

test('a Nano rewrite scoring below the threshold is retried once, and the better result wins', async () => {
  offlineSettings();
  const record = fakeNanoQueue(['Nano result', GOOD_REWRITE]);
  const r = await optimizePrompt('fix the bug', { engine: 'nano', frameworkId: 'smart-expand' });

  /* Session sequence: rewrite (low score) → on-device judge (degrades, the
     queue's text carries no verdict) → retry rewrite. */
  assert.equal(record.created, 3);
  assert.match(record.prompts[1], /Raw draft/, 'the middle call is the judge');
  assert.equal(r.optimized, GOOD_REWRITE, 'the retry that scores higher is kept');
  assert.equal(r.score.after, 100);
  assert.ok(r.score.before < r.score.after);
  assert.equal(record.destroyed, 3, 'every session is destroyed');
});

test('a Nano rewrite that already satisfies its contract is not retried', async () => {
  offlineSettings();
  const record = fakeNanoQueue([GOOD_REWRITE]);
  const r = await optimizePrompt('fix the bug', { engine: 'nano', frameworkId: 'smart-expand' });
  assert.equal(record.created, 1, 'no retry above the threshold');
  assert.equal(r.optimized, GOOD_REWRITE);
});

test('scoreRetry: false disables the retry even for a poor rewrite', async () => {
  offlineSettings();
  const record = fakeNanoQueue(['Nano result']);
  const r = await optimizePrompt('fix the bug', { engine: 'nano', frameworkId: 'smart-expand', scoreRetry: false });
  /* The judge still runs (nanoJudge defaults on) but its reply parses to
     nothing, so the honest rule score stands. */
  assert.equal(record.created, 2);
  assert.equal(r.optimized, 'Nano result');
  assert.ok(r.score.after < 55, 'the low score is reported honestly');
  assert.equal(r.score.method, 'rules');
});

test('a failed retry never degrades the first result', async () => {
  offlineSettings();
  let call = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async () => {
        call++;
        if (call === 2) throw new Error('session died mid-retry');
        return 'Nano result';
      },
      destroy() {}
    })
  };
  const r = await optimizePrompt('fix the bug', { engine: 'nano', frameworkId: 'smart-expand' });
  assert.equal(r.degraded, false, 'a retry failure is not an engine failure');
  assert.equal(r.optimized, 'Nano result');
});

test('a cloud rewrite is scored by rules and never retried by default', async () => {
  installChromeStub({ promptcraft_settings: { schemaVersion: 3, preferredEngine: 'openai', openaiApiKey: 'K', openaiModel: 'm' } });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Nano-like short reply' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  const r = await optimizePrompt('fix the bug', { engine: 'openai', frameworkId: 'smart-expand' });
  assert.equal(calls, 1, 'no surprise second cloud call');
  assert.equal(r.score.method, 'rules', 'no Nano judge for cloud results');
  assert.equal(r.degraded, false);
});
