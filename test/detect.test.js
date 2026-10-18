'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isCorrection, extractRule, tokens, similarity } = require('../lib/detect');

test('flags corrections', () => {
  for (const t of [
    "no, don't mock the database",
    'I told you to use pnpm, not npm',
    'stop adding comments to every line',
    'why did you delete the test file?',
    "that's not what I asked for",
    'You keep using markdown headers in replies',
    'please never commit without asking me first',
    'wrong, use the existing helper instead',
  ]) {
    assert.ok(isCorrection(t), t);
  }
});

test('ignores ordinary requests', () => {
  for (const t of [
    'add a dark mode toggle to the settings page',
    'now write tests for the parser',
    'looks great, ship it',
    'can you explain how the cache works?',
    'Note that the API returns paginated results',
    'nothing else, thanks',
    'Why do you want to work at Acme?',
    'Why are you interested in working at Initech',
  ]) {
    assert.ok(!isCorrection(t), t);
  }
});

test('flags indirect style steering', () => {
  for (const t of [
    'can you make it more concise',
    'clean up the learn section, it should just be a few paragraphs instead of all the bullets',
    'I like the previous one better because it said what I did',
    'keep it short',
    'too much detail here',
  ]) {
    assert.ok(isCorrection(t), t);
  }
});

test('after an interrupt or rejection, the next message is a redirect', () => {
  assert.ok(!isCorrection('just commit locally for now'));
  assert.ok(isCorrection('just commit locally for now', { redirect: true }));
  assert.ok(!isCorrection('continue', { redirect: true }));});

test('ignores corrections buried in pasted code', () => {
  assert.ok(!isCorrection('here is the error:\n```\nno such file, stop\n```'));
});

test('extracts the directive sentence', () => {
  assert.strictEqual(
    extractRule("ugh. why did you do that? Don't mock the database, use the test container."),
    "Don't mock the database, use the test container."
  );
  assert.strictEqual(extractRule('no, use pnpm'), 'Use pnpm');
  assert.strictEqual(extractRule('no emojis in commit messages please'), 'No emojis in commit messages please');
  assert.strictEqual(extractRule('stop adding comments to every line'), 'Stop adding comments to every line');
  assert.ok(isCorrection('use pnpm, not npm'));
});

test('groups the same complaint phrased differently', () => {
  const a = tokens("Don't mock the database in tests");
  const b = tokens('stop mocking the database, use the real one');
  const c = tokens('use tabs for indentation');
  assert.ok(similarity(a, b) >= 0.5);
  assert.ok(similarity(a, c) < 0.5);
  assert.strictEqual(similarity(tokens('How can I make claude responses more concise'), tokens('Way too long.')), 1);
  assert.strictEqual(similarity(tokens('a few paragraphs instead of all the bullets'), tokens('no markdown headers please')), 1);
  assert.strictEqual(similarity(tokens('Way too long.'), tokens('use pnpm, not npm')), 0);
  assert.ok(
    similarity(tokens("Dont change anything yet, just propose the changes here first"), tokens('Undo and list the changes here first')) >= 0.5
  );
});
