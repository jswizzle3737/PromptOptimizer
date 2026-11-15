import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, sha256Hex } from './helpers.mjs';
import {
  DEFAULT_SETTINGS, SCHEMA_VERSION, PROVIDER_DEFAULTS, MAX_HISTORY_MIN, MAX_HISTORY_MAX,
  clampMaxHistory, normalizeBaseUrl, migrateSettings, getSettings, saveSettings,
  getHistory, addHistoryEntry, removeHistoryEntry, clearHistory
} from '../shared/storage.js';
import { escapeHtml } from '../shared/select.js';

/* A stand-in credential. The real retired key is never written into a test:
   migrateSettings takes the retired hashes as a parameter for this reason. */
const RETIRED = 'sk-or-v1-test-retired-credential';
let RETIRED_HASHES;

beforeEach(async () => {
  RETIRED_HASHES = new Set([await sha256Hex(RETIRED)]);
});

test('defaults ship with no credential and Chrome Nano selected', () => {
  assert.equal(DEFAULT_SETTINGS.openrouterApiKey, '');
  assert.equal(DEFAULT_SETTINGS.omnirouteApiKey, '');
  assert.equal(DEFAULT_SETTINGS.omnirouteEnabled, false);
  assert.equal(DEFAULT_SETTINGS.omnirouteBaseUrl, 'http://localhost:20128/v1');
  assert.equal(DEFAULT_SETTINGS.omnirouteModel, 'auto');
  assert.equal(DEFAULT_SETTINGS.allowCloudFallback, true);
  assert.equal(DEFAULT_SETTINGS.preferredEngine, 'nano');
  assert.equal(SCHEMA_VERSION, 4);
});

test('a fresh install resolves to the new defaults', async () => {
  const s = await migrateSettings(undefined, RETIRED_HASHES);
  assert.equal(s.openrouterApiKey, '');
  assert.equal(s.preferredEngine, 'nano');
  assert.equal(s.allowCloudFallback, true);
  assert.equal(s.omnirouteEnabled, false);
  assert.equal(s.schemaVersion, 4);
});

test('the retired embedded key is blanked and the engine moves off OpenRouter', async () => {
  const s = await migrateSettings(
    { schemaVersion: 2, preferredEngine: 'openrouter', openrouterApiKey: RETIRED },
    RETIRED_HASHES
  );
  assert.equal(s.openrouterApiKey, '');
  assert.equal(s.preferredEngine, 'nano');
});

test('a retired key under another engine is blanked but the engine is kept', async () => {
  const s = await migrateSettings(
    { schemaVersion: 2, preferredEngine: 'gemini', openrouterApiKey: RETIRED },
    RETIRED_HASHES
  );
  assert.equal(s.openrouterApiKey, '');
  assert.equal(s.preferredEngine, 'gemini');
});

test("the user's own OpenRouter key and engine are never touched", async () => {
  const s = await migrateSettings(
    { schemaVersion: 2, preferredEngine: 'openrouter', openrouterApiKey: 'sk-or-v1-mine' },
    RETIRED_HASHES
  );
  assert.equal(s.openrouterApiKey, 'sk-or-v1-mine');
  assert.equal(s.preferredEngine, 'openrouter');
});

test('retired model defaults are remapped, custom model choices are not', async () => {
  const old = await migrateSettings({
    schemaVersion: 2,
    geminiModel: 'gemini-1.5-flash',
    anthropicModel: 'claude-3-5-haiku-latest',
    openrouterModel: 'nex-agi/nex-n2.5-pro:free'
  }, RETIRED_HASHES);
  assert.equal(old.geminiModel, PROVIDER_DEFAULTS.gemini.model);
  assert.equal(old.anthropicModel, PROVIDER_DEFAULTS.anthropic.model);
  assert.equal(old.openrouterModel, PROVIDER_DEFAULTS.openrouter.model);

  const custom = await migrateSettings({
    schemaVersion: 2,
    geminiModel: 'my-tuned-model',
    anthropicModel: 'claude-custom',
    openrouterModel: 'meta/some-model:free'
  }, RETIRED_HASHES);
  assert.equal(custom.geminiModel, 'my-tuned-model');
  assert.equal(custom.anthropicModel, 'claude-custom');
  assert.equal(custom.openrouterModel, 'meta/some-model:free');
});

test('themes retired earlier still resolve', async () => {
  const s = await migrateSettings({ schemaVersion: 1, theme: 'cyberpunk' }, RETIRED_HASHES);
  assert.equal(s.theme, 'dark');
});

test('getSettings persists the migration once', async () => {
  const data = installChromeStub({
    promptcraft_settings: { schemaVersion: 2, preferredEngine: 'openrouter', geminiModel: 'gemini-1.5-flash' }
  });
  const s = await getSettings();
  assert.equal(s.schemaVersion, 4);
  assert.equal(data.promptcraft_settings.schemaVersion, 4);
  assert.equal(data.promptcraft_settings.geminiModel, PROVIDER_DEFAULTS.gemini.model);
});

test('no provider default is a retired model id', () => {
  const retired = ['gemini-1.5-flash', 'claude-3-5-haiku-latest', 'google/gemini-flash-1.5'];
  for (const p of Object.values(PROVIDER_DEFAULTS)) assert.ok(!retired.includes(p.model));
});

/* saveSettings is read-modify-write, so two surfaces writing at once could each
   read the same base and the second clobber the first. The write chain must make
   each write see the previous one, so concurrent writes to different fields both
   survive. */
test('concurrent saveSettings calls do not lose each other’s fields', async () => {
  const data = installChromeStub({
    promptcraft_settings: { schemaVersion: 4, preferredEngine: 'nano', theme: 'dark' }
  });
  await Promise.all([
    saveSettings({ preferredEngine: 'openrouter' }),
    saveSettings({ theme: 'ember' })
  ]);
  assert.equal(data.promptcraft_settings.preferredEngine, 'openrouter', 'first write survived');
  assert.equal(data.promptcraft_settings.theme, 'ember', 'second write survived');
});

test('a rejected saveSettings does not wedge later writes', async () => {
  installChromeStub({ promptcraft_settings: { schemaVersion: 4, theme: 'dark' } });
  // Force the first write to fail mid-flight, then confirm a later write still lands.
  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('disk full'); };
  await assert.rejects(saveSettings({ theme: 'ember' }), /disk full/);
  chrome.storage.local.set = originalSet;
  const saved = await saveSettings({ preferredEngine: 'gemini' });
  assert.equal(saved.preferredEngine, 'gemini');
  assert.equal(saved.theme, 'dark', 'base fields are still present after recovery');
});

/* escapeHtml feeds double-quoted attributes, so an unescaped apostrophe would
   let a value break out of an attribute the day one is single-quoted. */
test('escapeHtml neutralises single quotes as well as the double-quote set', () => {
  assert.equal(escapeHtml("O'Brien"), 'O&#39;Brien');
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml(`<a href="x" onmouseover='y'>&`), '&lt;a href=&quot;x&quot; onmouseover=&#39;y&#39;&gt;&amp;');
  assert.equal(escapeHtml(undefined), '');
});

/* ----------------------------------------------------------- v4 migrations */

test('v3 to v4 migration normalizes omniroute, allowCloudFallback, and maxHistoryItems', async () => {
  const strict = await migrateSettings({
    schemaVersion: 3,
    allowCloudFallback: false,
    omnirouteApiKey: 'or-local-key',
    omnirouteBaseUrl: 'http://localhost:20128/',
    maxHistoryItems: 500
  }, RETIRED_HASHES);
  assert.equal(strict.schemaVersion, 4);
  assert.equal(strict.allowCloudFallback, false);
  assert.equal(strict.omnirouteEnabled, true, 'key enables omniroute automatically');
  assert.equal(strict.omnirouteBaseUrl, 'http://localhost:20128/v1');
  assert.equal(strict.maxHistoryItems, MAX_HISTORY_MAX);

  const selected = await migrateSettings({
    schemaVersion: 3,
    preferredEngine: 'omniroute',
    omnirouteBaseUrl: 'ftp://invalid',
    maxHistoryItems: 1
  }, RETIRED_HASHES);
  assert.equal(selected.omnirouteEnabled, true, 'preferredEngine omniroute enables gateway');
  assert.equal(selected.omnirouteBaseUrl, PROVIDER_DEFAULTS.omniroute.baseUrl);
  assert.equal(selected.maxHistoryItems, MAX_HISTORY_MIN);
  assert.equal(selected.allowCloudFallback, true);
});

test('normalizeBaseUrl strips slashes, adds /v1 only when path is empty, and rejects non-HTTP(S)', () => {
  assert.equal(normalizeBaseUrl('http://localhost:20128'), 'http://localhost:20128/v1');
  assert.equal(normalizeBaseUrl('http://localhost:20128/'), 'http://localhost:20128/v1');
  assert.equal(normalizeBaseUrl('https://gw.example.com/custom///'), 'https://gw.example.com/custom');
  assert.equal(normalizeBaseUrl('https://gw.example.com/api/v2'), 'https://gw.example.com/api/v2');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl('ftp://localhost:20128'), '');
  assert.equal(normalizeBaseUrl('javascript:alert(1)'), '');
  assert.equal(normalizeBaseUrl('not-a-url'), '');
});

test('clampMaxHistory bounds integers to [5, 100]', () => {
  assert.equal(clampMaxHistory(0), MAX_HISTORY_MIN);
  assert.equal(clampMaxHistory(5), 5);
  assert.equal(clampMaxHistory(42), 42);
  assert.equal(clampMaxHistory(100), 100);
  assert.equal(clampMaxHistory(999), MAX_HISTORY_MAX);
  assert.equal(clampMaxHistory('abc', 25), 25);
});

/* ----------------------------------------------------------- history CRUD */

test('addHistoryEntry deduplicates (original, framework), enforces clamped max, and serializes writes', async () => {
  installChromeStub({ promptcraft_settings: { schemaVersion: 4, maxHistoryItems: 5 } });

  const first = await addHistoryEntry({ original: 'draft A', optimized: 'opt A1', engine: 'offline', framework: 'rtf' });
  await addHistoryEntry({ original: 'draft A', optimized: 'opt A2', engine: 'openai', framework: 'smart-expand' });
  const dedup = await addHistoryEntry({ original: 'draft A', optimized: 'opt A3', engine: 'openai', framework: 'rtf' });

  let list = await getHistory();
  assert.equal(list.length, 2, 'same (original, framework) replaces previous entry');
  assert.equal(list[0].id, dedup.id);
  assert.equal(list[0].optimized, 'opt A3');
  assert.ok(!list.some(e => e.id === first.id));

  await Promise.all([
    addHistoryEntry({ original: 'd1', optimized: 'o1', engine: 'offline', framework: 'rtf' }),
    addHistoryEntry({ original: 'd2', optimized: 'o2', engine: 'offline', framework: 'rtf' }),
    addHistoryEntry({ original: 'd3', optimized: 'o3', engine: 'offline', framework: 'rtf' }),
    addHistoryEntry({ original: 'd4', optimized: 'o4', engine: 'offline', framework: 'rtf' }),
    addHistoryEntry({ original: 'd5', optimized: 'o5', engine: 'offline', framework: 'rtf' })
  ]);
  list = await getHistory();
  assert.equal(list.length, 5, 'capped at clamped maxHistoryItems = 5');

  const removed = await removeHistoryEntry(list[0].id);
  assert.equal(removed, true);
  assert.equal((await getHistory()).length, 4);
  assert.equal(await removeHistoryEntry('nonexistent'), false);

  await clearHistory();
  assert.deepEqual(await getHistory(), []);
});

