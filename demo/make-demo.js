#!/usr/bin/env node
'use strict';

// Builds a fake Claude Code history in /tmp/grudge-demo so the README GIF
// never shows anyone's real transcripts. See demo/demo.tape.

const fs = require('fs');
const path = require('path');

const ROOT = '/tmp/grudge-demo';
fs.rmSync(ROOT, { recursive: true, force: true });

const projects = {
  'checkout-api': [
    ["add retry logic to the payment client", "no, don't mock the database in the tests, use the test container"],
    ['write tests for the refund flow', 'stop mocking the database. use the docker test db'],
    ['fix the flaky webhook test', "I told you, don't mock the db — use the real test container"],
    ['add a migration for refunds', 'never edit an existing migration, add a new one'],
    ['rename the column', "don't edit old migrations, make a new migration instead"],
  ],
  'web-app': [
    ['add a date picker to the form', "no, don't install a library for this, use the native input"],
    ['add a settings page', 'stop adding comments to every line'],
    ['clean up the header', "you keep adding comments on every line. don't"],
    ['commit this', 'no emojis in commit messages please'],
    ['commit the fix', 'I said no emojis in commit messages'],
  ],
  dotfiles: [
    ['update my zshrc', 'use pnpm, not npm'],
    ['install the deps', 'I told you to use pnpm instead of npm'],
    ['push it', "don't push, just commit locally"],
    ['ok push the other branch', "wait, don't push anything without asking me"],
  ],
};

let day = 1;
for (const [proj, sessions] of Object.entries(projects)) {
  const dir = path.join(ROOT, 'claude', `-Users-dev-${proj}`);
  fs.mkdirSync(dir, { recursive: true });
  sessions.forEach(([ask, correction], i) => {
    const session = `${proj}-${i}`;
    const ts = (h) => new Date(Date.UTC(2026, 8, day, h)).toISOString();
    const lines = [
      { type: 'user', sessionId: session, cwd: `/Users/dev/${proj}`, timestamp: ts(9), message: { role: 'user', content: ask } },
      { type: 'assistant', sessionId: session, timestamp: ts(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] } },
      { type: 'user', sessionId: session, cwd: `/Users/dev/${proj}`, timestamp: ts(10), message: { role: 'user', content: correction } },
      { type: 'user', sessionId: session, cwd: `/Users/dev/${proj}`, timestamp: ts(11), message: { role: 'user', content: 'looks good, thanks' } },
    ];
    fs.writeFileSync(path.join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    day += 3;
  });
}
console.log(`demo history written to ${ROOT}`);
