import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOfflineOptimization, DEFAULT_FRAMEWORKS } from '../shared/frameworks.js';

const SOFTWARE = /Software Engineer/;
const COMMS = /Communications Strategist/;
const DATA = /Data Scientist/;
const GENERIC = /Senior Domain Expert/;

const run = (text, id = 'rtf') => generateOfflineOptimization(text, id, DEFAULT_FRAMEWORKS);

test('plain words that merely contain "go" do not pick the engineer persona', () => {
  assert.match(run('Give me a good category list for the garden'), GENERIC);
  assert.match(run('What was the weather like a month ago'), GENERIC);
});

test('whole-word code cues still pick the engineer persona', () => {
  assert.match(run('Fix this Python function bug'), SOFTWARE);
  assert.match(run('Write a Rust CLI that parses CSS'), SOFTWARE);
  assert.match(run('Port the service to Golang'), SOFTWARE);
  // the language, named the way people actually name it, still counts
  assert.match(run('build a rest api in go'), SOFTWARE);
  assert.match(run('Explain goroutines to me'), SOFTWARE);
});

test('writing and analysis personas keep their precedence', () => {
  assert.match(run('Write an email to my landlord'), COMMS);
  assert.match(run('Analyze the quarterly sales data'), DATA);
  // code beats write, as before
  assert.match(run('Write a Python script'), SOFTWARE);
});

test('substring look-alikes of other cues do not misfire', () => {
  assert.match(run('Please trust the process and overwrite nothing'), GENERIC);
  assert.match(run('A note about copyright law'), GENERIC);
});

test('replacement patterns inside the prompt stay literal', () => {
  const out = run("Explain what $& and $' and $1 mean in a regex replace", 'rtf');
  assert.ok(out.includes("$& and $' and $1"), 'dollar patterns must survive verbatim');
});

test('placeholders typed by the user are not substituted again', () => {
  const out = run('Describe the token {{persona}} in templates', 'rtf');
  assert.ok(out.includes('{{persona}}'), 'user text must not be re-substituted');
});

test('every default framework still renders without leftover placeholders', () => {
  for (const fw of DEFAULT_FRAMEWORKS) {
    const out = generateOfflineOptimization('plan a team offsite', fw.id, DEFAULT_FRAMEWORKS);
    assert.doesNotMatch(out, /{{\w+}}/, `${fw.id} left a placeholder`);
    assert.ok(out.includes('plan a team offsite'));
  }
});

test('empty input yields an empty string', () => {
  assert.equal(generateOfflineOptimization('   '), '');
});
