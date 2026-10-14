/**
 * Storage management helper for PromptOptimizer.
 * Uses chrome.storage.local for keys, settings, and optimization history.
 *
 * Also the single place where persisted state is migrated forward. Anything
 * that changes shape between versions must be normalised here, because
 * chrome.storage.local outlives the code that wrote it — editing a default
 * constant alone will never reach an existing install.
 */

import { hasIcon } from './icons.js';
import { THEMES, DEFAULT_THEME, migrateTheme, LEGACY_THEME_IDS } from './theme-picker.js';

/* Theme metadata lives in theme-picker.js — single source of truth.
   Re-exported here so existing consumers keep working. */
export { THEMES, DEFAULT_THEME, migrateTheme, LEGACY_THEME_IDS, hasIcon };

/** Bump when persisted shapes change. Read by `migrateSettings`. */
export const SCHEMA_VERSION = 3;

/**
 * Per-provider model defaults. The one place these live — the engine, the
 * Options page and its connection tests all read from here.
 * IDs were checked against each provider's published model list on 2026-10-02.
 * Anthropic defaults to Sonnet because Haiku 4.5's retirement floor is
 * 2026-10-15; Sonnet 5.5's is not before 2027-09.
 */
export const PROVIDER_DEFAULTS = {
  gemini: { model: 'gemini-3.5-flash-lite' },
  openai: { model: 'gpt-4o-mini' },
  anthropic: { model: 'claude-sonnet-5-5' },
  openrouter: { model: 'openrouter/free' }
};

/**
 * Convenience list for the OpenRouter picker. Deliberately just the auto-router:
 * a hardcoded list of free models goes stale within weeks, and Options has a
 * "Fetch live models" button for the real, current set.
 */
export const OPENROUTER_FREE_MODELS = [
  { id: 'openrouter/free', name: 'OpenRouter Auto Free Router (best available free model)' }
];

/**
 * Model ids that were defaults in earlier versions and no longer exist. A stored
 * value equal to one of these is a default nobody chose, so it is safe to replace;
 * any other stored value is the user's own and is left alone.
 */
const RETIRED_MODEL_DEFAULTS = {
  geminiModel: ['gemini-1.5-flash'],
  anthropicModel: ['claude-3-5-haiku-latest'],
  openrouterModel: ['nex-agi/nex-n2.5-pro:free', 'inclusionai/ling-3.0-flash-vl:free', 'google/gemini-flash-1.5']
};

/**
 * SHA-256 of an OpenRouter credential that earlier builds shipped inside this
 * file. Only the hash is kept so the secret is not in source again, but installs
 * that still hold it can be recognised and cleared. Rotating the key at
 * OpenRouter is what actually revokes it.
 */
export const RETIRED_OPENROUTER_KEY_HASHES = new Set([
  'd2a01e526c5b075450e1f2d7569c87f54012343fcb42fde3a972a09ecbb9de77'
]);

export const DEFAULT_SETTINGS = {
  schemaVersion: SCHEMA_VERSION,
  preferredEngine: 'nano',
  preferredFramework: 'smart-expand',
  enableFloatingWidget: true,
  geminiApiKey: '',
  geminiModel: PROVIDER_DEFAULTS.gemini.model,
  openaiApiKey: '',
  openaiModel: PROVIDER_DEFAULTS.openai.model,
  anthropicApiKey: '',
  anthropicModel: PROVIDER_DEFAULTS.anthropic.model,
  openrouterApiKey: '',
  openrouterModel: PROVIDER_DEFAULTS.openrouter.model,
  customSystemPrompt: '',
  showDiffView: true,
  /** How many alternative rewrites to produce per optimization: 1-3. */
  variantCount: 1,
  /** Send the page's title, URL and selection along as context. Off: opt-in. */
  includePageContext: false,
  /** Set once the user dismisses the "connect an AI engine" card. */
  setupDismissed: false,
  theme: DEFAULT_THEME,
  maxHistoryItems: 20,
  /** Set once the first-run guide has been dismissed. */
  onboardingComplete: false
};

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalise a settings object read from storage.
 * Never throws — a corrupt value degrades to its default rather than breaking
 * every surface that calls getSettings().
 *
 * @param {object} [stored]
 * @param {Set<string>} [retiredKeyHashes]  Injectable so tests never need the real key.
 */
export async function migrateSettings(stored, retiredKeyHashes = RETIRED_OPENROUTER_KEY_HASHES) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };

  // v1 → v2: four themes retired. Anything that no longer exists resolves to
  // the default so no surface can be left unthemed.
  merged.theme = migrateTheme(merged.theme);

  // v2 → v3: builds up to 1.0.0 stored a developer-owned OpenRouter key as the
  // default credential. Clear it, and move anyone who was on that engine only
  // because it was the default over to the new default. A key the user typed
  // themselves never matches, so it is untouched.
  const key = typeof merged.openrouterApiKey === 'string' ? merged.openrouterApiKey.trim() : '';
  if (key && retiredKeyHashes.has(await sha256Hex(key))) {
    merged.openrouterApiKey = '';
    if (merged.preferredEngine === 'openrouter') merged.preferredEngine = DEFAULT_SETTINGS.preferredEngine;
  }

  // v2 → v3: model ids that were defaults and have since been retired.
  const providerKey = { geminiModel: 'gemini', anthropicModel: 'anthropic', openrouterModel: 'openrouter' };
  for (const [field, retired] of Object.entries(RETIRED_MODEL_DEFAULTS)) {
    if (retired.includes(merged[field])) merged[field] = PROVIDER_DEFAULTS[providerKey[field]].model;
  }

  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

export async function getSettings() {
  const result = await chrome.storage.local.get('promptcraft_settings');
  const migrated = await migrateSettings(result.promptcraft_settings);

  // Persist the migration once, so it is not recomputed on every read.
  if (result.promptcraft_settings && result.promptcraft_settings.schemaVersion !== SCHEMA_VERSION) {
    await chrome.storage.local.set({ promptcraft_settings: migrated });
  }
  return migrated;
}

/* Serialises settings writes. saveSettings is read-modify-write, so two writes
   in the same context would each read the same base and the second would
   overwrite the first's field (a lost update). Chaining every write onto one
   promise makes each read see the previous write. The chain is kept alive even
   when a write rejects, so one failure cannot wedge every later write.
   No read cache: popup, options, content and the worker are separate contexts,
   and a per-context cache would go stale the moment another one saved. */
let settingsWriteChain = Promise.resolve();

export async function saveSettings(partial) {
  const run = settingsWriteChain.then(async () => {
    const result = await chrome.storage.local.get('promptcraft_settings');
    const current = await migrateSettings(result.promptcraft_settings);
    const updated = { ...current, ...partial, schemaVersion: SCHEMA_VERSION };
    await chrome.storage.local.set({ promptcraft_settings: updated });
    return updated;
  });
  settingsWriteChain = run.then(() => {}, () => {});
  return run;
}

export async function getHistory() {
  const result = await chrome.storage.local.get('promptcraft_history');
  return result.promptcraft_history || [];
}

export async function addHistoryEntry(entry) {
  // Independent reads — fetch together so they overlap instead of serialising.
  const [history, settings] = await Promise.all([getHistory(), getSettings()]);
  const max = settings.maxHistoryItems || 20;

  const newEntry = {
    id: 'hist_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    timestamp: Date.now(),
    original: entry.original,
    optimized: entry.optimized,
    engine: entry.engine,
    framework: entry.framework,
    degraded: Boolean(entry.degraded)
  };

  const updated = [newEntry, ...history.filter(h => h.original !== entry.original)].slice(0, max);
  await chrome.storage.local.set({ promptcraft_history: updated });
  return newEntry;
}

export async function clearHistory() {
  await chrome.storage.local.set({ promptcraft_history: [] });
}

/* ------------------------------------------------------------------------ */
/* Per-site opt-in and the hand-off to the popup                              */
/* ------------------------------------------------------------------------ */

/** Origins the user has opted in to ("Show button on this site"). */
export const SITES_KEY = 'promptcraft_sites';

export async function getSites() {
  const { [SITES_KEY]: sites } = await chrome.storage.local.get(SITES_KEY);
  return Array.isArray(sites) ? sites : [];
}

const PENDING_KEY = 'promptcraft_pending';
const PENDING_TTL_MS = 2 * 60 * 1000;

/**
 * Pages an extension cannot script (chrome://, the Web Store, the PDF viewer)
 * cannot host the in-page modal. The service worker parks the text here and
 * opens the popup, which picks it up. Session-scoped, so it never outlives the
 * browser session.
 */
export async function setPendingPrompt({ text = '', autoRun = false } = {}) {
  await chrome.storage.session.set({ [PENDING_KEY]: { text, autoRun, at: Date.now() } });
}

/** Read and clear the parked prompt. Returns null if none, or if it has gone stale. */
export async function takePendingPrompt() {
  const { [PENDING_KEY]: pending } = await chrome.storage.session.get(PENDING_KEY);
  if (!pending) return null;
  await chrome.storage.session.remove(PENDING_KEY);
  return Date.now() - pending.at <= PENDING_TTL_MS ? pending : null;
}
