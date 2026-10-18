'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.GRUDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grudge-'));
const store = require('../lib/store');

const ex = (session, text, ts, extra = {}) => ({ session, text, rule: text, ts, project: 'app', source: 'claude', ...extra });

test('repeats across sessions become one standing grudge', () => {
  const db = store.load();
  store.addExample(db, ex('a', "don't mock the database in tests", '2026-01-01T00:00:00Z'));
  store.addExample(db, ex('b', 'stop mocking the database in tests', '2026-02-01T00:00:00Z'));
  assert.strictEqual(db.grudges.length, 1);
  assert.strictEqual(store.sessions(db.grudges[0]), 2);
  assert.strictEqual(store.standing(db, 'app').length, 1);
});

test('a resumed session copying old messages is not a repeat', () => {
  const db = store.load();
  const t = '2026-01-01T00:00:00Z';
  store.addExample(db, ex('a', 'no, use pnpm', t, { exactTs: true }));
  assert.strictEqual(store.addExample(db, ex('a-resumed', 'no, use pnpm', t, { exactTs: true })), null);
  assert.strictEqual(store.sessions(db.grudges[0]), 1);
});

test('an imported copy of a session seconds later is not a repeat', () => {
  const db = store.load();
  store.addExample(db, ex('claude-1', 'no, like add a skill instead', '2026-07-08T22:56:19.519Z', { exactTs: true }));
  store.addExample(db, ex('codex-import', 'No, like add a skill instead', '2026-07-08T22:56:21.000Z', { exactTs: true }));
  assert.strictEqual(store.sessions(db.grudges[0]), 1);
});

test('live hook and later scan of the same prompt count once', () => {
  const db = store.load();
  store.addExample(db, ex('s1', 'never commit without asking', '2026-01-01T00:00:05Z'));
  assert.strictEqual(store.addExample(db, ex('s1', 'never commit without asking', '2026-01-01T00:00:01Z', { exactTs: true })), null);
});

test('forgiven grudges are not injected; single-project grudges stay in their project', () => {
  const db = store.load();
  store.addExample(db, ex('a', 'use tabs for indentation', '2026-01-01T00:00:00Z'));
  store.addExample(db, ex('b', 'tabs for indentation please', '2026-01-02T00:00:00Z'));
  assert.strictEqual(store.standing(db, 'other-project').length, 0);
  db.grudges[0].status = 'forgiven';
  assert.strictEqual(store.standing(db, 'app').length, 0);
});
