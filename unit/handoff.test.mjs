import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers.mjs';
import { setPendingPrompt, takePendingPrompt, getSites, SITES_KEY } from '../shared/storage.js';

test('a parked prompt is returned once and then cleared', async () => {
  installChromeStub();
  await setPendingPrompt({ text: 'rough draft', autoRun: true });
  const first = await takePendingPrompt();
  assert.equal(first.text, 'rough draft');
  assert.equal(first.autoRun, true);
  assert.equal(await takePendingPrompt(), null);
});

test('a parked prompt older than two minutes is discarded', async () => {
  const stub = installChromeStub();
  await setPendingPrompt({ text: 'stale' });
  stub.__session.promptcraft_pending.at = Date.now() - 3 * 60 * 1000;
  assert.equal(await takePendingPrompt(), null);
});

test('nothing parked yields null', async () => {
  installChromeStub();
  assert.equal(await takePendingPrompt(), null);
});

test('the parked prompt lives in session storage, never in local', async () => {
  const stub = installChromeStub();
  await setPendingPrompt({ text: 'private' });
  assert.ok(!('promptcraft_pending' in stub), 'must not be persisted to chrome.storage.local');
  assert.ok('promptcraft_pending' in stub.__session);
});

test('getSites tolerates a missing or corrupt value', async () => {
  installChromeStub();
  assert.deepEqual(await getSites(), []);
  installChromeStub({ [SITES_KEY]: 'not-an-array' });
  assert.deepEqual(await getSites(), []);
  installChromeStub({ [SITES_KEY]: ['https://example.com'] });
  assert.deepEqual(await getSites(), ['https://example.com']);
});
