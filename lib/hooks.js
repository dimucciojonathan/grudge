'use strict';

// Claude Code hook handlers. Rules: never throw, never block, stay fast.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isCorrection, extractRule } = require('./detect');
const store = require('./store');

const CLI = path.resolve(__dirname, '..', 'bin', 'grudge.js');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function emit(event, context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}

// A stable path the /grudge skill can call, wherever the plugin is installed.
function writeShim() {
  const shim = path.join(store.HOME, 'grudge.js');
  const body = `#!/usr/bin/env node\nrequire(${JSON.stringify(CLI)});\n`;
  try {
    if (fs.existsSync(shim) && fs.readFileSync(shim, 'utf8') === body) return;
    fs.mkdirSync(store.HOME, { recursive: true });
    fs.writeFileSync(shim, body, { mode: 0o755 });
  } catch {}
}

function backgroundScan() {
  try {
    spawn(process.execPath, [CLI, 'scan', '--quiet'], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

function sessionStart() {
  const input = readStdin();
  writeShim();
  const db = store.load();
  if (!db.installedAt) {
    db.installedAt = new Date().toISOString();
    store.save(db);
  }
  backgroundScan();
  const project = input.cwd ? path.basename(input.cwd) : null;
  const list = store.standing(db, project);
  if (!list.length) return;
  // Refined grudges carry scoped rules ("When X: do Y"); inject those, and only
  // the project-scoped ones that belong to this project.
  const lines = [];
  for (const g of list) {
    if (g.refined && !g.refined.keep) continue;
    if (g.refined && g.refined.rules.length) {
      for (const r of g.refined.rules) {
        if (r.already_covered) continue;
        if (r.scope === 'project' && r.project && r.project !== project) continue;
        lines.push(`- When ${r.when.replace(/^when\s+/i, '').replace(/[.:,\s]+$/, '')}: ${r.rule} (${store.sessions(g)} sessions)`);
      }
    } else {
      lines.push(`- ${store.display(g)} (corrected in ${store.sessions(g)} sessions)`);
    }
  }
  if (!lines.length) return;
  emit(
    'SessionStart',
    '[grudge] The user has had to correct you about these things in more than one past session. ' +
      "Treat them as standing rules, but only in the situation each one names. Don't make them say it again:\n" +
      lines.slice(0, 15).join('\n')
  );
}

// Look at the end of the transcript: has Claude replied yet, and was the last
// thing the user did an interrupt (Esc) or a rejected tool call?
function context(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const prior = tail.includes('"type":"assistant"');
    const lines = tail.trimEnd().split('\n');
    let redirect = false;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
      const l = lines[i];
      if (l.includes('"type":"assistant"')) break;
      if (l.includes('[Request interrupted by user') || l.includes("The user doesn't want to proceed with this tool use")) {
        redirect = true;
        break;
      }
    }
    return { prior, redirect };
  } catch {
    return { prior: false, redirect: false };
  }
}

function prompt() {
  const input = readStdin();
  const text = input.prompt;
  if (!text) return;
  const { prior, redirect } = context(input.transcript_path);
  if (!prior || !isCorrection(text, { redirect })) return;
  const db = store.load();
  const g = store.addExample(db, {
    text,
    rule: extractRule(text),
    session: input.session_id || 'unknown',
    project: input.cwd ? path.basename(input.cwd) : null,
    ts: new Date().toISOString(),
    source: 'claude',
  });
  if (!g) return;
  store.save(db);
  if (g.status !== 'active' || store.sessions(g) < 2) return;
  emit(
    'UserPromptSubmit',
    `[grudge] The user is correcting something they have corrected in ${store.sessions(g)} separate sessions: ` +
      `"${store.display(g)}". Fix it without fuss and hold to it for the rest of this session.`
  );
}

function run(name) {
  try {
    if (name === 'session-start') sessionStart();
    else if (name === 'prompt') prompt();
  } catch {}
  process.exitCode = 0;
}

module.exports = { run };
