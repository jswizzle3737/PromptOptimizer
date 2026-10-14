import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './helpers.mjs';
import {
  LIBRARY_KEY, LIMITS, normalizeLabels, deriveTitle, getLibrary, saveToLibrary,
  updateLibraryEntry, deleteLibraryEntry, collectLabels, filterLibrary
} from '../shared/library.js';

let stub;
beforeEach(() => { stub = installChromeStub(); });

/* ----------------------------------------------------------------- labels */

test('normalizeLabels splits on commas, semicolons and newlines, and trims', () => {
  assert.deepEqual(normalizeLabels('code, writing ;  research\nops'), ['code', 'writing', 'research', 'ops']);
});

test('normalizeLabels strips leading # and drops empties', () => {
  assert.deepEqual(normalizeLabels('#work, ,##ideas,  '), ['work', 'ideas']);
});

test('normalizeLabels dedupes case-insensitively, keeping the first casing', () => {
  assert.deepEqual(normalizeLabels('Email, email, EMAIL, Sales'), ['Email', 'Sales']);
});

test('normalizeLabels collapses inner whitespace and accepts arrays', () => {
  assert.deepEqual(normalizeLabels(['  data   science ', 'sql']), ['data science', 'sql']);
});

test('normalizeLabels enforces the count and length limits', () => {
  const many = Array.from({ length: 25 }, (_, i) => `l${i}`);
  assert.equal(normalizeLabels(many).length, LIMITS.labels);
  const long = 'x'.repeat(100);
  assert.equal(normalizeLabels(long)[0].length, LIMITS.label);
});

test('normalizeLabels ignores non-strings and nullish input', () => {
  assert.deepEqual(normalizeLabels(undefined), []);
  assert.deepEqual(normalizeLabels(null), []);
  assert.deepEqual(normalizeLabels([1, null, {}, 'ok']), ['ok']);
});

/* ------------------------------------------------------------------ title */

test('deriveTitle uses the first meaningful line without markdown markers', () => {
  assert.equal(deriveTitle('\n\n### ROLE\nAct as a reviewer'), 'ROLE');
  assert.equal(deriveTitle('**Objective:**\nDo the thing'), 'Objective:');
  assert.equal(deriveTitle('- "Summarise this report"'), 'Summarise this report');
});

test('deriveTitle truncates long lines with an ellipsis and falls back when empty', () => {
  const t = deriveTitle('word '.repeat(40));
  assert.ok(t.length <= 61 && t.endsWith('…'));
  assert.equal(deriveTitle('   \n  '), 'Untitled prompt');
  assert.equal(deriveTitle(undefined), 'Untitled prompt');
});

/* ------------------------------------------------------------------- save */

test('saveToLibrary stores a labelled prompt and returns it', async () => {
  const entry = await saveToLibrary({
    title: '  Cold email  ', text: '  Write a cold email  ', original: 'cold email',
    labels: 'sales, Email', framework: 'rtf', engine: 'offline'
  });
  assert.match(entry.id, /^lib_/);
  assert.equal(entry.title, 'Cold email');
  assert.equal(entry.text, 'Write a cold email');
  assert.deepEqual(entry.labels, ['sales', 'Email']);
  assert.equal(entry.framework, 'rtf');
  assert.ok(entry.createdAt > 0 && entry.updatedAt >= entry.createdAt);
  assert.equal(stub[LIBRARY_KEY].length, 1);
});

test('saveToLibrary derives a title when none is given', async () => {
  const entry = await saveToLibrary({ text: '### ROLE\nAct as a reviewer' });
  assert.equal(entry.title, 'ROLE');
});

test('saveToLibrary refuses empty or oversized text and stores nothing', async () => {
  await assert.rejects(saveToLibrary({ text: '   ' }), /empty/i);
  await assert.rejects(saveToLibrary({ text: 'x'.repeat(LIMITS.text + 1) }), /too long/i);
  assert.ok(!(LIBRARY_KEY in stub));
});

test('saveToLibrary clamps the title length', async () => {
  const entry = await saveToLibrary({ title: 't'.repeat(500), text: 'body' });
  assert.equal(entry.title.length, LIMITS.title);
});

test('saveToLibrary gives every entry a distinct id', async () => {
  const a = await saveToLibrary({ text: 'one' });
  const b = await saveToLibrary({ text: 'two' });
  assert.notEqual(a.id, b.id);
});

test('the library has a hard cap and says so', async () => {
  stub[LIBRARY_KEY] = Array.from({ length: LIMITS.entries }, (_, i) => ({
    id: `lib_${i}`, title: `t${i}`, text: 'x', original: '', labels: [], framework: '', engine: '',
    createdAt: i, updatedAt: i
  }));
  await assert.rejects(saveToLibrary({ text: 'one more' }), /full/i);
  assert.equal(stub[LIBRARY_KEY].length, LIMITS.entries);
});

/* ------------------------------------------------------------------- read */

test('getLibrary returns newest-updated first', async () => {
  stub[LIBRARY_KEY] = [
    { id: 'a', title: 'old', text: 'x', labels: [], createdAt: 1, updatedAt: 1 },
    { id: 'b', title: 'new', text: 'x', labels: [], createdAt: 2, updatedAt: 9 },
    { id: 'c', title: 'mid', text: 'x', labels: [], createdAt: 3, updatedAt: 5 }
  ];
  assert.deepEqual((await getLibrary()).map(e => e.id), ['b', 'c', 'a']);
});

test('getLibrary tolerates a corrupt value and drops malformed entries', async () => {
  stub[LIBRARY_KEY] = 'garbage';
  assert.deepEqual(await getLibrary(), []);
  stub[LIBRARY_KEY] = [null, 7, { id: 'ok', text: 'fine' }, { id: 'no-text' }, { text: 'no-id' }];
  const lib = await getLibrary();
  assert.equal(lib.length, 1);
  assert.equal(lib[0].id, 'ok');
  assert.deepEqual(lib[0].labels, [], 'missing fields get safe defaults');
  assert.equal(typeof lib[0].title, 'string');
});

/* ----------------------------------------------------------------- update */

test('updateLibraryEntry changes title, text and labels and bumps updatedAt', async () => {
  const e = await saveToLibrary({ title: 'a', text: 'body', labels: 'x' });
  await new Promise(r => setTimeout(r, 5));
  const u = await updateLibraryEntry(e.id, { title: 'renamed', text: 'new body', labels: 'y, z' });
  assert.equal(u.title, 'renamed');
  assert.equal(u.text, 'new body');
  assert.deepEqual(u.labels, ['y', 'z']);
  assert.ok(u.updatedAt > e.updatedAt);
  assert.equal(u.createdAt, e.createdAt);
  assert.equal(u.id, e.id);
});

test('updateLibraryEntry ignores fields it does not own', async () => {
  const e = await saveToLibrary({ text: 'body' });
  const u = await updateLibraryEntry(e.id, { id: 'hijack', createdAt: 0, text: 'ok', engine: 'zzz' });
  assert.equal(u.id, e.id);
  assert.equal(u.createdAt, e.createdAt);
});

test('updateLibraryEntry rejects an unknown id or emptied text', async () => {
  await assert.rejects(updateLibraryEntry('nope', { title: 'x' }), /no longer exists/i);
  const e = await saveToLibrary({ text: 'body' });
  await assert.rejects(updateLibraryEntry(e.id, { text: '  ' }), /empty/i);
  assert.equal((await getLibrary())[0].text, 'body');
});

/* ----------------------------------------------------------------- delete */

test('deleteLibraryEntry removes exactly one entry', async () => {
  const a = await saveToLibrary({ text: 'one' });
  const b = await saveToLibrary({ text: 'two' });
  assert.equal(await deleteLibraryEntry(a.id), true);
  assert.deepEqual((await getLibrary()).map(e => e.id), [b.id]);
  assert.equal(await deleteLibraryEntry('missing'), false);
});

/* ------------------------------------------------- labels index and search */

const SAMPLE = [
  { id: '1', title: 'Cold email', text: 'Write a cold email', labels: ['Sales', 'email'], updatedAt: 3 },
  { id: '2', title: 'Bug triage', text: 'Triage this stack trace', labels: ['code', 'EMAIL'], updatedAt: 2 },
  { id: '3', title: 'Blog outline', text: 'Outline a post', labels: ['writing'], updatedAt: 1 }
];

test('collectLabels counts case-insensitively, most used first, then alphabetical', () => {
  assert.deepEqual(collectLabels(SAMPLE), [
    { label: 'email', count: 2 },
    { label: 'code', count: 1 },
    { label: 'Sales', count: 1 },
    { label: 'writing', count: 1 }
  ]);
});

test('filterLibrary searches title, body and labels, case-insensitively', () => {
  assert.deepEqual(filterLibrary(SAMPLE, { query: 'STACK' }).map(e => e.id), ['2']);
  assert.deepEqual(filterLibrary(SAMPLE, { query: 'outline' }).map(e => e.id), ['3']);
  assert.deepEqual(filterLibrary(SAMPLE, { query: 'sales' }).map(e => e.id), ['1']);
});

test('filterLibrary by label is exact and case-insensitive; query and label combine', () => {
  assert.deepEqual(filterLibrary(SAMPLE, { label: 'email' }).map(e => e.id), ['1', '2']);
  assert.deepEqual(filterLibrary(SAMPLE, { label: 'email', query: 'bug' }).map(e => e.id), ['2']);
  assert.deepEqual(filterLibrary(SAMPLE, { label: 'ema' }), [], 'a label is not a substring match');
});

test('filterLibrary with no criteria returns everything unchanged', () => {
  assert.equal(filterLibrary(SAMPLE, {}).length, 3);
  assert.equal(filterLibrary(SAMPLE).length, 3);
});
