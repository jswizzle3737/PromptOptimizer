/**
 * Deterministic WCAG contrast check for the PromptOptimizer theme tokens.
 * Parses shared/theme.css and measures the pairs that carry the interface.
 *
 * This is the fast, browser-free counterpart to verify_themes.js — same
 * thresholds, no CDP session required.
 *
 *   node check_contrast.js
 */

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, 'shared', 'theme.css'), 'utf8');

/* The designs on offer are whatever THEMES lists in theme-picker.js, the single
   source of truth. Each must have a block in theme.css that defines colour tokens. */
const PICKER = fs.readFileSync(path.join(__dirname, 'shared', 'theme-picker.js'), 'utf8');
const THEME_IDS = [...PICKER.matchAll(/^\s*id:\s*'([a-z]+)'/gm)].map(m => m[1]);

const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const BLOCKS = [...STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1], body: m[2] }));

/** The token block that defines a design's colours. */
function readTokens(id) {
  const block = BLOCKS.find(b => b.selector.includes(`[data-theme="${id}"]`) && /color-scheme:/.test(b.body));
  if (!block) throw new Error(`No colour block for design "${id}" in theme.css`);
  const body = block.body;
  const tokens = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

/* Pairs that carry meaning. [foreground token, background token, threshold, label] */
const PAIRS = [
  ['--text-primary',   '--bg-surface', AA_NORMAL, 'body text on card'],
  ['--text-secondary', '--bg-surface', AA_NORMAL, 'secondary text on card'],
  ['--text-tertiary',  '--bg-surface', AA_NORMAL, 'tertiary text on card'],
  ['--text-tertiary',  '--bg-raised',  AA_NORMAL, 'tertiary text on raised'],
  ['--text-tertiary',  '--bg-canvas',  AA_NORMAL, 'tertiary text on canvas'],
  ['--text-tertiary',  '--bg-sunken',  AA_NORMAL, 'tertiary text on sunken'],
  ['--accent-fg',      '--bg-surface', AA_NORMAL, 'accent text on card'],
  ['--text-on-accent', '--accent',     AA_NORMAL, 'primary button label'],
  ['--success-fg',     '--bg-surface', AA_NORMAL, 'success text'],
  ['--warning-fg',     '--bg-surface', AA_NORMAL, 'warning text'],
  ['--danger-fg',      '--bg-surface', AA_NORMAL, 'danger text'],
  ['--border-focus',   '--bg-surface', AA_LARGE,  'focus ring on card']
];

/* A design that omits a token silently inherits Ink's value, which is how a
   light design ends up with a dark shadow. Require the full set. */
const REQUIRED_PREFIXES = ['--bg-', '--border-', '--text-', '--accent', '--success', '--warning', '--danger', '--ring', '--shadow-', '--logo-'];
const REFERENCE = readTokens('dark');
const REQUIRED = Object.keys(REFERENCE).filter(k => REQUIRED_PREFIXES.some(p => k.startsWith(p)));

let failures = 0;
let checks = 0;

if (THEME_IDS.length === 0) {
  console.log('No designs found in theme-picker.js THEMES.');
  process.exit(1);
}

for (const name of THEME_IDS) {
  const tokens = readTokens(name);
  console.log(`\n${name.toUpperCase()} — ${Object.keys(tokens).length} tokens`);

  const missing = REQUIRED.filter(k => !(k in tokens));
  if (missing.length) {
    failures += missing.length;
    console.log(`  FAIL  missing tokens: ${missing.join(', ')}`);
  }

  for (const [fgTok, bgTok, threshold, label] of PAIRS) {
    const fg = tokens[fgTok];
    const bg = tokens[bgTok];
    if (!fg || !bg) {
      console.log(`  ?? ${label}: missing ${!fg ? fgTok : bgTok}`);
      continue;
    }
    const ratio = contrast(fg, bg);
    checks++;
    const pass = ratio >= threshold;
    if (!pass) failures++;
    console.log(
      `  ${pass ? 'PASS' : 'FAIL'}  ${ratio.toFixed(2)}:1  (min ${threshold})  ` +
      `${label}  ${fgTok} ${fg} on ${bgTok} ${bg}`
    );
  }
}

console.log(`\n${checks - failures}/${checks} pairs meet WCAG AA.`);
if (failures > 0) {
  console.log(`${failures} FAILING — fix the tokens in shared/theme.css.`);
  process.exit(1);
}
console.log('All measured pairs pass.');
