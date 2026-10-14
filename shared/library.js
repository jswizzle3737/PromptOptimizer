/**
 * Saved-prompt library: prompts the user keeps, named and labelled.
 *
 * Stored in chrome.storage.local under one key. Everything here is plain data
 * handling so it can be tested without a browser; the UI lives in Options, with
 * "Save" entry points in the popup and the in-page modal.
 */

export const LIBRARY_KEY = 'promptcraft_library';

export const LIMITS = {
  entries: 500,
  title: 120,
  text: 20000,
  labels: 10,
  label: 32
};

/* ------------------------------------------------------------------------ */
/* Pure helpers                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Turn "code, Writing; #ideas" (or an array) into a clean label list.
 * Case-insensitive de-duplication keeps the first spelling.
 */
export function normalizeLabels(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const label = item.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.label).trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= LIMITS.labels) break;
  }
  return out;
}

/** A readable default title: the first meaningful line, stripped of markdown. */
export function deriveTitle(text) {
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const cleaned = line
      .replace(/^[\s>#*\-+\d.)]+/, '')
      .replace(/[*_`"]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}…` : cleaned;
  }
  return 'Untitled prompt';
}

/** All labels in use with counts: most used first, then alphabetical. */
export function collectLabels(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const label of entry.labels || []) {
      const key = label.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count++;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) =>
    b.count - a.count || a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
}

/** Narrow a list by free-text query (title, body, labels) and/or one exact label. */
export function filterLibrary(entries, { query = '', label = '' } = {}) {
  const q = String(query).trim().toLowerCase();
  const l = String(label).trim().toLowerCase();
  return entries.filter(entry => {
    if (l && !(entry.labels || []).some(x => x.toLowerCase() === l)) return false;
    if (!q) return true;
    return entry.title.toLowerCase().includes(q)
      || entry.text.toLowerCase().includes(q)
      || (entry.labels || []).some(x => x.toLowerCase().includes(q));
  });
}

/* ------------------------------------------------------------------------ */
/* Storage                                                                   */
/* ------------------------------------------------------------------------ */

function coerce(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id !== 'string' || typeof entry.text !== 'string') return null;
  const createdAt = Number(entry.createdAt) || 0;
  return {
    id: entry.id,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : deriveTitle(entry.text),
    text: entry.text,
    original: typeof entry.original === 'string' ? entry.original : '',
    labels: normalizeLabels(entry.labels),
    framework: typeof entry.framework === 'string' ? entry.framework : '',
    engine: typeof entry.engine === 'string' ? entry.engine : '',
    createdAt,
    updatedAt: Number(entry.updatedAt) || createdAt
  };
}

async function readAll() {
  const { [LIBRARY_KEY]: stored } = await chrome.storage.local.get(LIBRARY_KEY);
  return Array.isArray(stored) ? stored.map(coerce).filter(Boolean) : [];
}

async function writeAll(entries) {
  await chrome.storage.local.set({ [LIBRARY_KEY]: entries });
}

function checkText(text) {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('The prompt is empty.');
  if (value.length > LIMITS.text) {
    throw new Error(`The prompt is too long (the limit is ${LIMITS.text.toLocaleString('en-US')} characters).`);
  }
  return value;
}

/** Saved prompts, most recently updated first. */
export async function getLibrary() {
  const entries = await readAll();
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Save a prompt. Only `text` is required; the title defaults to the first line.
 * @returns {Promise<object>} the stored entry
 */
export async function saveToLibrary({ title, text, original = '', labels, framework = '', engine = '' } = {}) {
  const body = checkText(text);
  const entries = await readAll();
  if (entries.length >= LIMITS.entries) {
    throw new Error(`The library is full (${LIMITS.entries} prompts). Delete some to save more.`);
  }

  const now = Date.now();
  const entry = {
    id: `lib_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: (String(title ?? '').trim() || deriveTitle(body)).slice(0, LIMITS.title),
    text: body,
    original: String(original ?? '').trim().slice(0, LIMITS.text),
    labels: normalizeLabels(labels),
    framework: String(framework ?? ''),
    engine: String(engine ?? ''),
    createdAt: now,
    updatedAt: now
  };

  await writeAll([entry, ...entries]);
  return entry;
}

/** Change an entry's title, text or labels. Other fields are not editable. */
export async function updateLibraryEntry(id, patch = {}) {
  const entries = await readAll();
  const index = entries.findIndex(e => e.id === id);
  if (index < 0) throw new Error('That saved prompt no longer exists.');

  const current = entries[index];
  const next = { ...current };
  if ('text' in patch) next.text = checkText(patch.text);
  if ('title' in patch) next.title = (String(patch.title ?? '').trim() || deriveTitle(next.text)).slice(0, LIMITS.title);
  if ('labels' in patch) next.labels = normalizeLabels(patch.labels);
  next.updatedAt = Math.max(Date.now(), current.updatedAt + 1);

  entries[index] = next;
  await writeAll(entries);
  return next;
}

/** @returns {Promise<boolean>} whether anything was removed */
export async function deleteLibraryEntry(id) {
  const entries = await readAll();
  const kept = entries.filter(e => e.id !== id);
  if (kept.length === entries.length) return false;
  await writeAll(kept);
  return true;
}
