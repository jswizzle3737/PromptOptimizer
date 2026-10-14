import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectSecrets, mayLeaveDevice, secretWarning } from '../shared/secrets.js';
import { extractVariables, fillTemplate } from '../shared/templates.js';
import { REFINEMENTS } from '../shared/optimizer-engine.js';
import { getTargetProfile } from '../shared/target-profiles.js';

/* ------------------------------------------------------------- secrets */

test('detectSecrets recognises common credential shapes', () => {
  const samples = {
    'an OpenAI or Anthropic API key': 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 here',
    'an AWS access key': 'AKIAIOSFODNN7EXAMPLE',
    'a GitHub token': 'ghp_' + 'a'.repeat(36),
    'a Google API key': 'AIza' + 'B'.repeat(35),
    'a Slack token': 'xoxb-1234567890-abcdef',
    'a Stripe secret key': 'sk_live_' + 'c'.repeat(24),
    'a JSON Web Token': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'a private key': '-----BEGIN RSA PRIVATE KEY-----\nMIIE',
    'a password': 'password: hunter2hunter2'
  };
  for (const [label, text] of Object.entries(samples)) {
    assert.deepEqual(detectSecrets(text), [label], label);
  }
});

test('ordinary prose about keys and passwords does not trip the detector', () => {
  for (const text of [
    'write an email reminding staff to rotate their API keys',
    'explain how JWTs work and what eyJ means',
    'my password policy needs 12 characters',
    'ask-me-anything about sk-learn models'
  ]) {
    assert.deepEqual(detectSecrets(text), [], text);
  }
});

test('the warning only applies when the draft can leave the device', () => {
  const draft = 'debug this: AKIAIOSFODNN7EXAMPLE';
  assert.equal(mayLeaveDevice('offline', {}), false);
  assert.equal(mayLeaveDevice('nano', {}), false, 'Nano alone stays on-device');
  assert.equal(mayLeaveDevice('nano', { openaiApiKey: 'K' }), true, 'Nano can fall back to a keyed provider');
  assert.equal(mayLeaveDevice('gemini', {}), true);
  assert.equal(secretWarning(draft, 'offline', {}), '');
  assert.match(secretWarning(draft, 'openai', {}), /an AWS access key\. It would be sent to a cloud AI provider/);
  assert.equal(secretWarning('no secrets here', 'openai', {}), '');
});

/* ------------------------------------------------------------- templates */

test('extractVariables lists each {{variable}} once, in order', () => {
  assert.deepEqual(
    extractVariables('Write to {{client name}} about {{topic}}. Sign as {{ Sender }}. Again: {{topic}}, {{TOPIC}}.'),
    ['client name', 'topic', 'Sender']
  );
  assert.deepEqual(extractVariables('no blanks, {{}} or {{1bad}} here'), []);
});

test('fillTemplate fills case-insensitively and keeps blank placeholders', () => {
  const t = 'Dear {{Name}}, re: {{topic}} ({{topic}}). {{missing}}';
  assert.equal(
    fillTemplate(t, { name: 'Ana', topic: 'Q3 plan', missing: '  ' }),
    'Dear Ana, re: Q3 plan (Q3 plan). {{missing}}'
  );
});

/* ------------------------------------------------------------- contracts */

test('the refine buttons in assist.js match the engine refinements', () => {
  // assist.js touches the DOM only when its factories run; read its table as text.
  const src = readFileSync(new URL('../shared/assist.js', import.meta.url), 'utf8');
  const kinds = [...src.matchAll(/\{ kind: '([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(kinds.sort(), Object.keys(REFINEMENTS).sort());
});

test('every shared module the in-page panel imports is web-accessible', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const war = new Set(manifest.web_accessible_resources.flatMap(w => w.resources));
  const content = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
  const imported = [...content.matchAll(/import\(SHARED \+ '([\w-]+\.js)'\)/g)].map(m => `shared/${m[1]}`);
  assert.ok(imported.length >= 10);
  const seen = new Set();
  const queue = [...imported];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(war.has(file), `${file} is imported by the panel but not web-accessible`);
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/from '\.\/([\w-]+\.js)'/g)) queue.push(`shared/${m[1]}`);
  }
});

test('new hosts are content-script targets and have model profiles where one applies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const matches = manifest.content_scripts[0].matches;
  for (const host of ['grok.com', 'copilot.microsoft.com', 'poe.com']) {
    assert.ok(matches.includes(`https://${host}/*`), host);
  }
  assert.equal(getTargetProfile('grok.com')?.id, 'grok');
  assert.equal(getTargetProfile('https://copilot.microsoft.com/chats/1')?.id, 'copilot');
  assert.equal(getTargetProfile('poe.com'), null, 'Poe hosts many models: no single profile');
  assert.ok(manifest.permissions.includes('offscreen'));
});
