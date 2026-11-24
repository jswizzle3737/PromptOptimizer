/**
 * PromptOptimizer Design System — Theme
 * Theme metadata, legacy-id migration, and the controls that switch it.
 *
 * Ten designs, chosen in Options. This list is the single source of truth for
 * which designs exist: theme.css must define each id below (check_contrast.js
 * fails if it does not), and nothing else may re-list them.
 *
 * `swatch` is [canvas, surface, accent] and is kept equal to the tokens in
 * theme.css by a unit test. `mode` is the colour scheme the design ships in.
 */

import { createSelect } from './select.js';

export const THEMES = [
  {
    id: 'dark',
    name: 'Ink',
    desc: 'Dark · slate, steel blue',
    mode: 'dark',
    swatch: ['#0B0D12', '#12151C', '#3B72C4']
  },
  {
    id: 'terminal',
    name: 'Terminal',
    desc: 'Dark · phosphor green, monospace',
    mode: 'dark',
    swatch: ['#080B08', '#0E130E', '#4FBF63']
  },
  {
    id: 'ember',
    name: 'Ember',
    desc: 'Dark · warm charcoal, burnt orange',
    mode: 'dark',
    swatch: ['#110E0C', '#191512', '#B8531B']
  },
  {
    id: 'harbor',
    name: 'Harbor',
    desc: 'Dark · deep teal, soft corners',
    mode: 'dark',
    swatch: ['#071214', '#0C1C1F', '#17807C']
  },
  {
    id: 'contrast',
    name: 'Contrast',
    desc: 'Dark · black and white, maximum legibility',
    mode: 'dark',
    swatch: ['#000000', '#080808', '#FFFFFF']
  },
  {
    id: 'amethyst',
    name: 'Amethyst',
    desc: 'Dark · deep violet, elegant serif',
    mode: 'dark',
    swatch: ['#0D0915', '#16101F', '#A855F7']
  },
  {
    id: 'midnight',
    name: 'Midnight',
    desc: 'Dark · rich indigo, gold accent',
    mode: 'dark',
    swatch: ['#060915', '#0C1428', '#F59E0B']
  },
  {
    id: 'aurora',
    name: 'Aurora',
    desc: 'Dark · teal-cyan, technical mono',
    mode: 'dark',
    swatch: ['#051014', '#0A1F26', '#06D6A0']
  },
  {
    id: 'light',
    name: 'Paper',
    desc: 'Light · crisp white, steel blue',
    mode: 'light',
    swatch: ['#F6F7F9', '#FFFFFF', '#2F62AE']
  },
  {
    id: 'manuscript',
    name: 'Manuscript',
    desc: 'Light · cream, serif, oxblood',
    mode: 'light',
    swatch: ['#F1EADB', '#FBF7EC', '#8C2F2B']
  },
  {
    id: 'sand',
    name: 'Sand',
    desc: 'Light · warm stone, terracotta',
    mode: 'light',
    swatch: ['#EEE8E0', '#FAF8F4', '#A8461F']
  },
  {
    id: 'glacier',
    name: 'Glacier',
    desc: 'Light · cool grey, deep teal',
    mode: 'light',
    swatch: ['#E9F0F4', '#F7FAFC', '#0F6483']
  },
  {
    id: 'meadow',
    name: 'Meadow',
    desc: 'Light · pale sage, forest green',
    mode: 'light',
    swatch: ['#ECF1E7', '#F8FAF4', '#2F6B3F']
  },
  {
    id: 'rose',
    name: 'Rose',
    desc: 'Light · blush pink, soft rounded',
    mode: 'light',
    swatch: ['#FFF1F3', '#FFFDFE', '#BE185D']
  },
  {
    id: 'ochre',
    name: 'Ochre',
    desc: 'Light · earthy clay, slab serif',
    mode: 'light',
    swatch: ['#F5EFE6', '#FDFBF7', '#A0522D']
  }
];

export const DEFAULT_THEME = 'dark';

/**
 * Palettes retired in v1.1.0. Kept as an explicit map rather than a silent
 * fallback so the migration is greppable and intentional. These ids must never
 * be reused for a new design.
 */
export const LEGACY_THEME_IDS = ['cyberpunk', 'monochrome', 'nord', 'solarized'];

/**
 * Normalise any stored theme id to one that still exists.
 * @param {string} [id]
 * @returns {string}
 */
export function migrateTheme(id) {
  if (!id) return DEFAULT_THEME;
  if (THEMES.some(t => t.id === id)) return id;
  if (LEGACY_THEME_IDS.includes(id)) return DEFAULT_THEME;
  return DEFAULT_THEME;
}

export function getTheme(id) {
  return THEMES.find(t => t.id === migrateTheme(id));
}

export function isDarkTheme(id) {
  return getTheme(id).mode === 'dark';
}

/**
 * Write the theme onto an element. Works for <html> (popup / options) and for
 * any element inside a shadow root (in-page modal), where :root does not exist.
 * Always normalises first, so a stale id can never reach the DOM.
 */
export function applyTheme(el, themeId) {
  if (!el) return;
  const theme = getTheme(themeId);
  el.setAttribute('data-theme', theme.id);
  const doc = el.ownerDocument || (el.nodeType === 9 ? el : null);
  if (doc?.documentElement) doc.documentElement.setAttribute('data-theme', theme.id);
}

function themeOptions() {
  return THEMES.map(t => ({
    value: t.id,
    label: t.name,
    desc: t.desc,
    swatch: t.swatch
  }));
}

/**
 * Build the labelled design listbox, for the Options console.
 * @param {object} cfg
 * @param {string} cfg.value
 * @param {(id:string)=>void} cfg.onChange
 * @param {'auto'|'up'|'down'} [cfg.placement]
 * @returns {{ element: HTMLElement, setValue:(id:string, opts?)=>void, getValue:()=>string, destroy:()=>void }}
 */
export function createThemePicker({ value = DEFAULT_THEME, onChange, placement = 'auto' } = {}) {
  return createSelect({
    options: themeOptions(),
    value: migrateTheme(value),
    onChange,
    label: 'Interface design',
    placement
  });
}

/**
 * Build the compact picker for dense toolbars (popup app bar, in-page modal
 * header): the trigger shows only the current design's swatch, the menu lists
 * all ten with names. Same control, same keyboard behaviour as the Options one.
 */
export function createThemeMenu({ value = DEFAULT_THEME, onChange, placement = 'down' } = {}) {
  return createSelect({
    options: themeOptions(),
    value: migrateTheme(value),
    onChange,
    label: 'Interface design',
    placement,
    compact: true
  });
}

/**
 * Subscribe to theme changes made in any other extension surface.
 * @param {(id:string)=>void} onChange
 * @returns {() => void} unsubscribe
 */
export function watchTheme(onChange) {
  if (!chrome?.storage?.onChanged) return () => {};
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const next = changes.promptcraft_settings?.newValue?.theme;
    const prev = changes.promptcraft_settings?.oldValue?.theme;
    if (next && next !== prev) onChange(migrateTheme(next));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
