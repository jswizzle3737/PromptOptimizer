import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers.mjs';
import {
  getTargetProfile, buildExplanationChips, TARGET_PROFILES, TECHNIQUES
} from '../shared/target-profiles.js';
import { generateOfflineOptimization, DEFAULT_FRAMEWORKS, analyzePromptSignals } from '../shared/frameworks.js';
import { optimizePrompt, buildSystemPrompt } from '../shared/optimizer-engine.js';

const originalChrome = globalThis.chrome;

beforeEach(() => { globalThis.chrome = originalChrome; });
afterEach(() => { globalThis.chrome = originalChrome; });

/* ------------------------------------------------------------ profiles */

test('every supported AI host resolves to its profile', () => {
  assert.equal(getTargetProfile('claude.ai').id, 'claude');
  assert.equal(getTargetProfile('chatgpt.com').id, 'openai');
  assert.equal(getTargetProfile('chat.openai.com').id, 'openai');
  assert.equal(getTargetProfile('gemini.google.com').id, 'gemini');
  assert.equal(getTargetProfile('www.perplexity.ai').id, 'perplexity');
  assert.equal(getTargetProfile('chat.deepseek.com').id, 'deepseek');
  assert.equal(getTargetProfile('chat.mistral.ai').id, 'mistral');
});

test('subdomains, full URLs, and mixed case still resolve', () => {
  assert.equal(getTargetProfile('labs.perplexity.ai').id, 'perplexity');
  assert.equal(getTargetProfile('https://chatgpt.com/c/abc-123').id, 'openai');
  assert.equal(getTargetProfile('Claude.AI').id, 'claude');
});

test('unrelated or missing hosts get no profile', () => {
  assert.equal(getTargetProfile('example.com'), null);
  assert.equal(getTargetProfile('notaclaude.ai'), null); // endsWith must be dot-anchored
  assert.equal(getTargetProfile(''), null);
  assert.equal(getTargetProfile(null), null);
  assert.equal(getTargetProfile(':::not a url:::'), null);
});

test('every profile carries guidance for both engine and offline paths', () => {
  for (const p of TARGET_PROFILES) {
    assert.ok(p.id && p.name, 'profile needs id and name');
    assert.ok(p.systemGuidance?.length > 20, `${p.id} needs system guidance`);
    assert.ok(p.offlineNote?.length > 10, `${p.id} needs an offline note`);
  }
});

/* ------------------------------------------------------------- chips */

test('chips reflect the framework techniques', () => {
  const chips = buildExplanationChips({ frameworkId: 'chain-of-thought' });
  const labels = chips.map(c => c.label);
  assert.ok(labels.includes(TECHNIQUES.decomposition.label));
  assert.ok(labels.includes(TECHNIQUES.verification.label));
  assert.ok(!labels.some(l => l.startsWith('Tuned for')));
});

test('custom frameworks fall back to a generic chip', () => {
  const chips = buildExplanationChips({ frameworkId: 'my-own-fw' });
  assert.deepEqual(chips.map(c => c.label), [TECHNIQUES.framework.label]);
});

test('a detected persona signal is presented first', () => {
  const chips = buildExplanationChips({ frameworkId: 'rtf', signal: 'code' });
  assert.match(chips[0].label, /persona detected/i);
  assert.match(chips[0].detail, /offline heuristic/i);
});

test('null signal adds no persona chip', () => {
  const chips = buildExplanationChips({ frameworkId: 'rtf', signal: null });
  assert.ok(!chips.some(c => /persona detected/i.test(c.label)));
});

test('a target profile adds a tuning chip with an explanation', () => {
  const chips = buildExplanationChips({ frameworkId: 'rtf', targetProfile: getTargetProfile('claude.ai') });
  const chip = chips.find(c => c.label === 'Tuned for Claude');
  assert.ok(chip, 'expected a Claude tuning chip');
  assert.match(chip.detail, /XML/i);
});

test('every chip has both a label and a hoverable detail', () => {
  for (const fw of DEFAULT_FRAMEWORKS) {
    for (const chip of buildExplanationChips({ frameworkId: fw.id, targetProfile: getTargetProfile('chatgpt.com') })) {
      assert.ok(chip.label && chip.detail, `${fw.id} produced a chip without label or detail`);
    }
  }
});

/* --------------------------------------------------- prompt construction */

test('buildSystemPrompt keeps the raw-prompt rule and adds the technique block', () => {
  const out = buildSystemPrompt('You rewrite prompts.');
  assert.match(out, /You rewrite prompts\./);
  assert.match(out, /<raw_prompt>/);
  assert.match(out, /quality techniques/i);
  assert.match(out, /citing sources/i);
});

test('buildSystemPrompt injects target guidance only when a profile is given', () => {
  const plain = buildSystemPrompt('Base.');
  assert.ok(!plain.includes('Perplexity'));
  const targeted = buildSystemPrompt('Base.', { targetProfile: getTargetProfile('www.perplexity.ai') });
  assert.match(targeted, /search-first/i);
  assert.match(targeted, /<raw_prompt>/);
});

/* ------------------------------------------------------ offline output */

test('offline output appends a target-model note only when asked', () => {
  const base = generateOfflineOptimization('plan a team offsite', 'rtf', DEFAULT_FRAMEWORKS);
  assert.ok(!base.includes('Target model note'));
  const targeted = generateOfflineOptimization('plan a team offsite', 'rtf', DEFAULT_FRAMEWORKS, {
    targetNote: getTargetProfile('perplexity.ai').offlineNote
  });
  assert.match(targeted, /\*\*Target model note:\*\*/);
  assert.ok(targeted.startsWith(base), 'the note is appended, not interleaved into the template');
});

test('analyzePromptSignals reports which cue group fired', () => {
  assert.equal(analyzePromptSignals('debug this python bug').signal, 'code');
  assert.equal(analyzePromptSignals('write a blog post').signal, 'writing');
  assert.equal(analyzePromptSignals('analyze the metrics').signal, 'analysis');
  assert.equal(analyzePromptSignals('plan a picnic').signal, null);
});

/* ---------------------------------------------------------- integration */

test('optimizePrompt returns techniques and target for a Claude host', async () => {
  installChromeStub({ promptcraft_settings: { schemaVersion: 3, preferredEngine: 'offline' } });
  const r = await optimizePrompt('Fix this Python function bug', {
    engine: 'offline', host: 'claude.ai'
  });
  assert.equal(r.engine, 'offline');
  assert.deepEqual(r.target, { id: 'claude', name: 'Claude' });
  assert.ok(Array.isArray(r.techniques) && r.techniques.length > 0);
  assert.ok(r.techniques.some(c => c.label === 'Tuned for Claude'));
  // offline-produced output may honestly claim the heuristic persona signal
  assert.ok(r.techniques.some(c => /persona detected/i.test(c.label)));
  assert.match(r.optimized, /\*\*Target model note:\*\*/);
});

test('optimizePrompt without a host returns no target and no tuning chip', async () => {
  installChromeStub({ promptcraft_settings: { schemaVersion: 3, preferredEngine: 'offline' } });
  const r = await optimizePrompt('summarize this report', { engine: 'offline' });
  assert.equal(r.target, null);
  assert.ok(!r.techniques.some(c => c.label.startsWith('Tuned for')));
});
