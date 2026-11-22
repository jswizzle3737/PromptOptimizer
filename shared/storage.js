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
import { isEngine } from './engines.js';
import { THEMES, DEFAULT_THEME, migrateTheme, LEGACY_THEME_IDS } from './theme-picker.js';

/* Theme metadata lives in theme-picker.js — single source of truth.
   Re-exported here so existing consumers keep working. */
export { THEMES, DEFAULT_THEME, migrateTheme, LEGACY_THEME_IDS, hasIcon };

/** Bump when persisted shapes change. Read by `migrateSettings`. */
export const SCHEMA_VERSION = 6;

export const MAX_HISTORY_MIN = 5;
export const MAX_HISTORY_MAX = 100;

export function clampMaxHistory(value, fallback = 20) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MAX_HISTORY_MIN, Math.min(MAX_HISTORY_MAX, n));
}

/**
 * Normalise an OpenAI-compatible base URL (OmniRoute gateway).
 * Strips trailing slashes and appends `/v1` only when no explicit path prefix
 * is present, returning '' for empty or non-HTTP(S) input.
 */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const cleanPath = url.pathname.replace(/\/+$/, '');
  return cleanPath ? `${url.origin}${cleanPath}` : `${url.origin}/v1`;
}

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
  openrouter: { model: 'openrouter/free' },
  omniroute: { model: 'auto', baseUrl: 'http://localhost:20128/v1' }
};

/**
 * Curated quick presets for provider pickers in Options. Users can still
 * enter any custom model ID in the paired text field.
 */
export const PROVIDER_MODEL_PRESETS = {
  omniroute: [
    { id: 'auto', name: 'Auto Router (best available route)' },
    { id: 'auto/coding:free', name: 'Auto Coding (free combo)' },
    { id: 'auto/reasoning:free', name: 'Auto Reasoning (free combo)' }
  ],
  gemini: [
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (Default / Fast)' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' }
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini (Default / Fast)' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    { id: 'o4-mini', name: 'o4-mini (Reasoning)' }
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Default)' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }
  ]
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
  quickRepairEnabled: true,
  allowCloudFallback: false,
  fallback1Engine: '',
  fallback1Model: '',
  fallback2Engine: '',
  fallback2Model: '',
  geminiApiKey: '',
  geminiModel: PROVIDER_DEFAULTS.gemini.model,
  openaiApiKey: '',
  openaiModel: PROVIDER_DEFAULTS.openai.model,
  anthropicApiKey: '',
  anthropicModel: PROVIDER_DEFAULTS.anthropic.model,
  openrouterApiKey: '',
  openrouterModel: PROVIDER_DEFAULTS.openrouter.model,
  omnirouteEnabled: false,
  omnirouteBaseUrl: PROVIDER_DEFAULTS.omniroute.baseUrl,
  omnirouteApiKey: '',
  omnirouteModel: PROVIDER_DEFAULTS.omniroute.model,
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

  // v3 → v4: OmniRoute gateway configuration, cloud fallback privacy control,
  // and clamped history capacity.
  merged.omnirouteApiKey = typeof merged.omnirouteApiKey === 'string' ? merged.omnirouteApiKey : '';
  merged.omnirouteBaseUrl = normalizeBaseUrl(merged.omnirouteBaseUrl) || PROVIDER_DEFAULTS.omniroute.baseUrl;
  const omModel = typeof merged.omnirouteModel === 'string' ? merged.omnirouteModel.trim() : '';
  merged.omnirouteModel = omModel || PROVIDER_DEFAULTS.omniroute.model;
  merged.omnirouteEnabled = Boolean(
    merged.omnirouteEnabled ||
    merged.omnirouteApiKey.trim() ||
    merged.preferredEngine === 'omniroute'
  );
  merged.maxHistoryItems = clampMaxHistory(merged.maxHistoryItems, DEFAULT_SETTINGS.maxHistoryItems);

  // v4 → v5: Ordered fallback slots (Fallback 1, Fallback 2). Clear unknown
  // engines and drop any model override paired with '', 'nano', or 'offline'.
  // Never mutate omnirouteEnabled here — explicit fallback slots handle it directly.
  for (const idx of [1, 2]) {
    const eKey = `fallback${idx}Engine`;
    const mKey = `fallback${idx}Model`;
    const rawEngine = typeof merged[eKey] === 'string' ? merged[eKey].trim() : '';
    const validEngine = rawEngine && isEngine(rawEngine) ? rawEngine : '';
    merged[eKey] = validEngine;
    const rawModel = typeof merged[mKey] === 'string' ? merged[mKey].trim() : '';
    merged[mKey] = !validEngine || validEngine === 'nano' || validEngine === 'offline' ? '' : rawModel;
  }

  // Earlier versions enabled cloud fallback by default, even with empty slots.
  // Keep an existing opt-in only when the user chose a provider in a slot.
  const hasNamedCloudFallback = [merged.fallback1Engine, merged.fallback2Engine]
    .some(engine => engine && engine !== 'nano' && engine !== 'offline');
  merged.allowCloudFallback = merged.allowCloudFallback === true &&
    (stored?.schemaVersion === SCHEMA_VERSION || hasNamedCloudFallback);

  merged.quickRepairEnabled = merged.quickRepairEnabled !== false;

  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

export async function getSettings() {
  const result = await chrome.storage.local.get('promptcraft_settings');
  return migrateSettings(result.promptcraft_settings);
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
    const updated = await migrateSettings({ ...current, ...partial, schemaVersion: SCHEMA_VERSION });
    await chrome.storage.local.set({ promptcraft_settings: updated });
    return updated;
  });
  settingsWriteChain = run.then(() => {}, () => {});
  return run;
}

export async function getHistory() {
  const result = await chrome.storage.local.get('promptcraft_history');
  return Array.isArray(result.promptcraft_history) ? result.promptcraft_history : [];
}

let historyWriteChain = Promise.resolve();

function serializeHistoryWrite(fn) {
  const run = historyWriteChain.then(fn);
  historyWriteChain = run.then(() => {}, () => {});
  return run;
}

export async function addHistoryEntry(entry) {
  return serializeHistoryWrite(async () => {
    // Independent reads — fetch together so they overlap instead of serialising.
    const [history, settings] = await Promise.all([getHistory(), getSettings()]);
    const max = clampMaxHistory(settings.maxHistoryItems, 20);

    const newEntry = {
      id: 'hist_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      timestamp: Date.now(),
      original: entry.original,
      optimized: entry.optimized,
      engine: entry.engine,
      framework: entry.framework,
      degraded: Boolean(entry.degraded)
    };

    const updated = [
      newEntry,
      ...history.filter(h => !(h.original === entry.original && h.framework === entry.framework))
    ].slice(0, max);
    await chrome.storage.local.set({ promptcraft_history: updated });
    return newEntry;
  });
}

export async function removeHistoryEntry(id) {
  return serializeHistoryWrite(async () => {
    const history = await getHistory();
    const updated = history.filter(h => h.id !== id);
    await chrome.storage.local.set({ promptcraft_history: updated });
    return updated.length !== history.length;
  });
}

export async function clearHistory() {
  return serializeHistoryWrite(async () => {
    await chrome.storage.local.set({ promptcraft_history: [] });
  });
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
