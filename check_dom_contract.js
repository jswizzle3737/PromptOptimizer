/**
 * Static DOM contract check.
 * Extracts every id/class a script looks up and confirms the markup defines it.
 * Catches the "renamed an element, forgot a consumer" class of bug without a
 * browser session.
 *
 *   node check_dom_contract.js
 */

const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');

/** Surfaces: script -> markup(s) it drives. */
const SURFACES = [
  { name: 'popup', script: 'popup/popup.js', markup: ['popup/popup.html'] },
  { name: 'options', script: 'options/options.js', markup: ['options/options.html'] },
  { name: 'content', script: 'content/content.js', markup: ['content/content.js'] }
];

function collectIds(js) {
  const ids = new Set();
  // document.getElementById('x')
  for (const m of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  // $('x') and $('#x') — both shorthands appear in this codebase
  for (const m of js.matchAll(/[$]\(\s*['"]#?([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1]);
  return ids;
}

function markupIds(markup) {
  const ids = new Set();
  for (const m of markup.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(m[1]);
  return ids;
}

let problems = 0;

for (const surface of SURFACES) {
  const js = read(surface.script);
  const ids = collectIds(js);
  const defined = new Set();
  for (const f of surface.markup) for (const id of markupIds(read(f))) defined.add(id);

  const missing = [...ids].filter(id => !defined.has(id));
  const status = missing.length === 0 ? 'OK  ' : 'FAIL';
  if (missing.length) problems++;
  console.log(`${status} ${surface.name}: ${ids.size} ids referenced, ${missing.length} unresolved`);
  for (const id of missing) console.log(`       missing #${id}`);
}

/* Classes the scripts inject must exist in the stylesheets that surface loads. */
const CSS = ['shared/theme.css', 'shared/base.css', 'shared/components.css', 'popup/popup.css']
  .map(read).join('\n');

const REQUIRED_CLASSES = [
  'pc-segmented', 'pc-segmented__item', 'pc-segmented__icon',
  'pc-callout', 'pc-callout--warning', 'pc-callout__title',
  'pc-badge', 'pc-badge--warning', 'pc-badge--accent', 'pc-badge--mono',
  'pc-icon-btn', 'pc-btn--primary', 'pc-spinner', 'pc-status-dot',
  'pc-status-dot--success', 'pc-status-dot--warning', 'pc-status-dot--danger',
  'pc-onboarding', 'pc-onboarding__step', 'pc-onboarding__num',
  'pc-shortcut-hint', 'pc-history__item', 'pc-empty', 'pc-toast', 'is-visible'
];

console.log('');
const missingClasses = REQUIRED_CLASSES.filter(c => !CSS.includes('.' + c));
if (missingClasses.length) {
  problems++;
  console.log(`FAIL stylesheets: ${missingClasses.length} classes used by scripts are undefined`);
  for (const c of missingClasses) console.log(`       missing .${c}`);
} else {
  console.log(`OK   stylesheets: all ${REQUIRED_CLASSES.length} script-injected classes are defined`);
}

console.log('');
if (problems) {
  console.log(`${problems} surface(s) with unresolved references.`);
  process.exit(1);
}
console.log('DOM contract intact.');
