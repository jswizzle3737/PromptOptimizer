import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEMES, DEFAULT_THEME, LEGACY_THEME_IDS, migrateTheme, getTheme, isDarkTheme
} from '../shared/theme-picker.js';
import { ENGINES, DEFAULT_ENGINE, ENGINE_LABELS, isEngine, engineOptions } from '../shared/engines.js';
import { hasIcon } from '../shared/icons.js';

const CSS = readFileSync(new URL('../shared/theme.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const BLOCKS = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1], body: m[2] }));

function tokensFor(id) {
  const block = BLOCKS.find(b => b.selector.includes(`[data-theme="${id}"]`) && /color-scheme:/.test(b.body));
  assert.ok(block, `theme.css has no colour block for "${id}"`);
  const out = {};
  for (const m of block.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  out['color-scheme'] = /color-scheme:\s*(\w+)/.exec(block.body)[1];
  return out;
}

const REQUIRED_PREFIXES = ['--bg-', '--border-', '--text-', '--accent', '--success', '--warning', '--danger', '--ring', '--shadow-', '--logo-'];
const REFERENCE = tokensFor('dark');
const REQUIRED = Object.keys(REFERENCE).filter(k => REQUIRED_PREFIXES.some(p => k.startsWith(p)));

test('fifteen designs, eight dark and seven light, with unique ids', () => {
  assert.equal(THEMES.length, 15);
  assert.equal(new Set(THEMES.map(t => t.id)).size, 15);
  assert.equal(THEMES.filter(t => t.mode === 'dark').length, 8);
  assert.equal(THEMES.filter(t => t.mode === 'light').length, 7);
  assert.equal(new Set(THEMES.map(t => t.name)).size, 15, 'names must be distinct too');
});

test('every design is complete: name, description, three-colour swatch', () => {
  for (const t of THEMES) {
    assert.ok(t.name && t.desc, `${t.id} needs a name and description`);
    assert.equal(t.swatch.length, 3);
    for (const c of t.swatch) assert.match(c, /^#[0-9A-F]{6}$/i);
  }
});

test('no design reuses a retired id', () => {
  for (const t of THEMES) assert.ok(!LEGACY_THEME_IDS.includes(t.id), `${t.id} is a retired id`);
});

test('theme.css defines every colour token for every design', () => {
  for (const t of THEMES) {
    const tokens = tokensFor(t.id);
    const missing = REQUIRED.filter(k => !(k in tokens));
    assert.deepEqual(missing, [], `${t.id} is missing ${missing.join(', ')}`);
  }
});

test('the picker swatch and mode match what theme.css actually renders', () => {
  for (const t of THEMES) {
    const tokens = tokensFor(t.id);
    assert.equal(t.swatch[0].toUpperCase(), tokens['--bg-canvas'].toUpperCase(), `${t.id} canvas`);
    assert.equal(t.swatch[1].toUpperCase(), tokens['--bg-surface'].toUpperCase(), `${t.id} surface`);
    assert.equal(t.swatch[2].toUpperCase(), tokens['--accent'].toUpperCase(), `${t.id} accent`);
    assert.equal(tokens['color-scheme'], t.mode, `${t.id} mode`);
  }
});

test('every design is more than a recolour: at least one non-colour token differs', () => {
  // Ink and Paper are the baseline pair; the other eight must each own a type,
  // corner or weight decision.
  for (const t of THEMES.filter(t => !['dark', 'light'].includes(t.id))) {
    const tokens = tokensFor(t.id);
    const own = Object.keys(tokens).filter(k => /^--(font-|radius-|weight-|tracking-)/.test(k));
    assert.ok(own.length > 0, `${t.id} overrides no type, radius or weight token`);
  }
});

test('the ten designs have distinct accents', () => {
  const accents = THEMES.map(t => tokensFor(t.id)['--accent'].toUpperCase());
  assert.equal(new Set(accents).size, THEMES.length);
});

test('migrateTheme: every id maps to itself, anything else to the default', () => {
  for (const t of THEMES) assert.equal(migrateTheme(t.id), t.id);
  for (const id of LEGACY_THEME_IDS) assert.equal(migrateTheme(id), DEFAULT_THEME);
  assert.equal(migrateTheme('no-such-design'), DEFAULT_THEME);
  assert.equal(migrateTheme(undefined), DEFAULT_THEME);
  assert.equal(migrateTheme(''), DEFAULT_THEME);
});

test('getTheme and isDarkTheme tolerate stale ids', () => {
  assert.equal(getTheme('ember').name, 'Ember');
  assert.equal(getTheme('cyberpunk').id, DEFAULT_THEME);
  assert.equal(isDarkTheme('terminal'), true);
  assert.equal(isDarkTheme('meadow'), false);
  assert.equal(isDarkTheme('nonsense'), true, 'falls back to the dark default');
});

/* ---------------------------------------------------------------- engines */

test('engines: unique values, known icons, default is offered', () => {
  assert.equal(new Set(ENGINES.map(e => e.value)).size, ENGINES.length);
  for (const e of ENGINES) assert.ok(hasIcon(e.icon), `${e.value} icon "${e.icon}" is not in the icon set`);
  assert.ok(isEngine(DEFAULT_ENGINE));
  assert.ok(!isEngine('openrouter-free'));
  assert.equal(ENGINE_LABELS.nano, 'Chrome Nano');
});

test('engineOptions: compact and full wordings both cover every engine', () => {
  assert.equal(engineOptions().length, ENGINES.length);
  const full = engineOptions({ full: true });
  assert.equal(full.find(o => o.value === 'gemini').label, 'Google Gemini');
  assert.equal(engineOptions().find(o => o.value === 'gemini').label, 'Gemini');
});
