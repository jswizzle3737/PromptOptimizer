import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = p => existsSync(new URL(`../${p}`, import.meta.url));

/* ship-files.json decides what reaches users (package.mjs) and what the
   browser test loads (test_extension.js). A folder missing from it once
   made the offscreen Nano host fail only in the packaged build. */
test('every file the manifest or the Nano bridge needs is in the ship list', () => {
  const { files } = JSON.parse(read('ship-files.json'));
  const manifest = JSON.parse(read('manifest.json'));
  const bridge = read('background/nano-bridge.js');
  const offscreenUrl = bridge.match(/OFFSCREEN_URL = '([^']+)'/)[1];
  const needed = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    offscreenUrl,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(c => [...c.js, ...(c.css || [])]),
    ...manifest.web_accessible_resources.flatMap(w => w.resources)
  ];
  for (const p of needed) {
    assert.ok(files.some(f => p === f || p.startsWith(`${f}/`)), `${p} is not shipped`);
    assert.ok(exists(p), `${p} does not exist`);
  }
  for (const dev of ['.research', 'design-preview', 'unit', 'docs', 'test_extension.js']) {
    assert.ok(!files.includes(dev), `${dev} must not ship`);
  }
});
