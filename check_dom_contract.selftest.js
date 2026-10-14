/**
 * Self-test for check_dom_contract.js's extractor.
 * Proves the check can actually fail, so a green run means something.
 *
 *   node check_dom_contract.selftest.js
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'check_dom_contract.js'), 'utf8');

// Re-create the extractor exactly as defined in the checker.
function collectIds(js) {
  const ids = new Set();
  for (const m of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/[$]\(\s*['"]#?([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1]);
  return ids;
}

const fixture = `
  const a = document.getElementById('real-one');
  const b = $('real-two');
  const c = $('#real-three');
  const d = document.getElementById('bogus-one');
  const e = $('bogus-two');
`;

const ids = collectIds(fixture);
const defined = new Set(['real-one', 'real-two', 'real-three']);
const missing = [...ids].filter(i => !defined.has(i)).sort();

console.log('extracted :', [...ids].sort().join(', '));
console.log('missing   :', missing.join(', '));

const ok =
  ids.size === 5 &&
  missing.length === 2 &&
  missing[0] === 'bogus-one' &&
  missing[1] === 'bogus-two';

// Guard against the checker drifting away from this copy of the logic.
const checkerHasBothPatterns =
  src.includes('getElementById') && src.includes("[A-Za-z0-9_-]+") && src.includes('#?');

console.log('');
console.log(ok ? 'PASS  extractor finds all 5 ids and flags exactly the 2 bogus ones' : 'FAIL  extractor is wrong');
console.log(checkerHasBothPatterns ? 'PASS  checker still uses both id patterns' : 'FAIL  checker pattern drifted');
process.exit(ok && checkerHasBothPatterns ? 0 : 1);
