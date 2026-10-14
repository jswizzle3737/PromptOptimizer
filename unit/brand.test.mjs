import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

const NAME = 'PromptOptimizer';
const ORG = 'yourlegalaid';

test('the app is named PromptOptimizer everywhere the browser shows a name', () => {
  assert.equal(manifest.name, NAME);
  assert.equal(manifest.action.default_title, NAME);
  assert.match(manifest.commands['open-optimizer'].description, new RegExp(NAME));
});

test('no shipped file still calls the product PromptCraft', () => {
  // Storage keys and element ids stay lowercase `promptcraft_*` on purpose, so
  // existing installs keep their data. Only the capitalised display name is checked.
  const files = [
    'manifest.json', 'popup/popup.html', 'popup/popup.js', 'options/options.html', 'options/options.js',
    'content/content.js', 'background/service-worker.js', 'shared/optimizer-engine.js',
    'README.md', 'CHROMEWEBSTORE.md', '.impeccable.md', '.cursorrules'
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /PromptCraft/, `${file} still says PromptCraft`);
  }
});

test('internal identifiers were deliberately left alone', () => {
  // Renaming these would orphan every existing install's saved settings.
  assert.match(read('shared/storage.js'), /promptcraft_settings|promptcraft_history/);
  assert.match(read('shared/library.js'), /promptcraft_library/);
});

test('the context menu names the product', () => {
  assert.match(read('background/service-worker.js'), /title: 'Optimize with PromptOptimizer'/);
});

test('popup and Options both open with the logo and the yourlegalaid wordmark', () => {
  for (const page of ['popup/popup.html', 'options/options.html']) {
    const html = read(page);
    assert.match(html, /class="pc-lockup"/, `${page} has no lockup`);
    assert.match(html, /<img class="pc-lockup__logo" src="..\/assets\/logo\.png"/, `${page} does not use the logo`);
    assert.match(html, new RegExp(`class="pc-lockup__word">${ORG}<`), `${page} is missing the wordmark`);
    // The lockup must come before the app bar: it is the top of the page.
    assert.ok(html.indexOf('pc-lockup') < html.indexOf('pc-appbar'), `${page}: lockup must precede the app bar`);
  }
});

test('the logo asset exists, is a PNG, and is reachable from the in-page modal', () => {
  const file = new URL('assets/logo.png', root);
  assert.ok(existsSync(file), 'assets/logo.png is missing');
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'not a PNG');
  assert.ok(statSync(file).size < 100_000, 'the logo should stay small');

  // PNG colour type 6 = RGBA: the background must be transparent, or the logo
  // draws a black box on every light design.
  const colourType = bytes[25];
  assert.equal(colourType, 6, 'the logo must have an alpha channel');

  const war = manifest.web_accessible_resources.flatMap(r => r.resources);
  assert.ok(war.includes('assets/logo.png'), 'the in-page modal cannot load the logo');
});

test('lockup logo and wordmark share one size token', () => {
  const css = read('shared/components.css');
  const lockup = css.slice(css.indexOf('.pc-lockup {'));
  assert.match(lockup, /--lockup-size:\s*\d+px/);
  assert.match(lockup, /\.pc-lockup__logo\s*\{[^}]*height:\s*var\(--lockup-size\)/);
  assert.match(lockup, /\.pc-lockup__word\s*\{[^}]*font-size:\s*var\(--lockup-size\)/);
});

test('the content script never rewrites the whole settings object', () => {
  const content = read('content/content.js');
  assert.doesNotMatch(content, /storage\.local\.set\(\{\s*promptcraft_settings/, 'content.js writes the settings object directly');
  assert.match(content, /type: 'SET_THEME'/);
});
