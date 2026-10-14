import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, sha256Hex } from './helpers.mjs';
import {
  DEFAULT_SETTINGS, SCHEMA_VERSION, PROVIDER_DEFAULTS, migrateSettings, getSettings, saveSettings
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
  assert.equal(DEFAULT_SETTINGS.preferredEngine, 'nano');
  assert.equal(SCHEMA_VERSION, 3);
});

test('a fresh install resolves to the new defaults', async () => {
  const s = await migrateSettings(undefined, RETIRED_HASHES);
  assert.equal(s.openrouterApiKey, '');
  assert.equal(s.preferredEngine, 'nano');
  assert.equal(s.schemaVersion, 3);
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
  assert.equal(s.schemaVersion, 3);
  assert.equal(data.promptcraft_settings.schemaVersion, 3);
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
    promptcraft_settings: { schemaVersion: 3, preferredEngine: 'nano', theme: 'dark' }
  });
  await Promise.all([
    saveSettings({ preferredEngine: 'openrouter' }),
    saveSettings({ theme: 'ember' })
  ]);
  assert.equal(data.promptcraft_settings.preferredEngine, 'openrouter', 'first write survived');
  assert.equal(data.promptcraft_settings.theme, 'ember', 'second write survived');
});

test('a rejected saveSettings does not wedge later writes', async () => {
  installChromeStub({ promptcraft_settings: { schemaVersion: 3, theme: 'dark' } });
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
