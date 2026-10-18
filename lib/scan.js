'use strict';

// Incremental scanner over local agent history. Transcripts are append-only
// JSONL, so each file is resumed from the last byte offset we fully read.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isCorrection, extractRule } = require('./detect');
const store = require('./store');

const CLAUDE_DIR = process.env.GRUDGE_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = process.env.GRUDGE_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions');

function weekOf(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function listClaude() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CLAUDE_DIR, d.name);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith('.jsonl')) out.push({ file: path.join(dir, f), source: 'claude' });
  }
  return out;
}

function listCodex(dir = CODEX_DIR, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listCodex(p, out);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push({ file: p, source: 'codex' });
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((c) => c && (c.type === 'tool_result' || c.tool_use_id))) return null;
  const parts = content.filter((c) => c && (c.type === 'text' || c.type === 'input_text')).map((c) => c.text);
  return parts.length ? parts.join('\n') : null;
}

function isHumanText(t) {
  if (!t) return false;
  const s = t.trimStart();
  return !(s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted'));
}

// Yields complete lines starting at `start`, plus the byte offset after each.
async function* lines(file, start) {
  const stream = fs.createReadStream(file, { start });
  let buf = Buffer.alloc(0);
  let offset = start;
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let nl;
    while ((nl = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, nl).toString('utf8');
      offset += nl + 1;
      buf = buf.subarray(nl + 1);
      yield { line, offset };
    }
  }
}

const REJECTED = "The user doesn't want to proceed with this tool use";
const INTERRUPTED = '[Request interrupted by user';

function toolResultText(c) {
  if (typeof c.content === 'string') return c.content;
  if (Array.isArray(c.content)) return c.content.map((x) => (x && x.text) || '').join('\n');
  return '';
}

// Parse one transcript line into a normalized event, or null.
//   prompt     – something the human typed
//   assistant  – Claude replied (we only need to know it happened)
//   tool       – Claude called a tool (remembered in case it gets rejected)
//   rejection  – the human rejected a tool call
//   interrupt  – the human hit Esc mid-turn
function parseClaude(line, state) {
  const isUser = line.includes('"type":"user"');
  const wantAssistant = line.includes('"type":"assistant"') && (!state.sawAssistant || line.includes('"tool_use"'));
  if (!isUser && !wantAssistant) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o.isSidechain) return null;
  if (o.type === 'assistant') {
    const content = (o.message && o.message.content) || [];
    const uses = Array.isArray(content) ? content.filter((c) => c && c.type === 'tool_use') : [];
    if (uses.length) {
      const u = uses[uses.length - 1];
      return { kind: 'tool', name: u.name, command: u.input && typeof u.input.command === 'string' ? u.input.command : null };
    }
    return { kind: 'assistant' };
  }
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary) return null;
  if (o.promptSource === 'sdk' || String(o.entrypoint || '').startsWith('sdk')) return null;
  const base = { ts: o.timestamp, session: o.sessionId, project: o.cwd ? path.basename(o.cwd) : null };
  const content = o.message && o.message.content;
  if (Array.isArray(content)) {
    const rejected = content.find((c) => c && c.type === 'tool_result' && toolResultText(c).startsWith(REJECTED));
    if (rejected) return { kind: 'rejection', ...base };
  }
  const text = textOf(content);
  if (text && text.trimStart().startsWith(INTERRUPTED)) return { kind: 'interrupt', ...base };
  if (!isHumanText(text)) return null;
  return { kind: 'prompt', text, ...base };
}

// "git push origin main" → "git push"; "rm -rf build" → "rm -rf"
function commandHead(cmd) {
  const words = String(cmd).trim().split(/\s+/).filter((w) => !/^[A-Z_]+=/.test(w));
  return words.slice(0, words[1] && !words[1].includes('/') ? 2 : 1).join(' ');
}

function parseCodex(line, state) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const p = o.payload || {};
  if (o.type === 'session_meta' && p.cwd) {
    state.project = path.basename(p.cwd);
    return null;
  }
  if (o.type !== 'response_item' || p.type !== 'message') return null;
  if (p.role === 'assistant') return { kind: 'assistant' };
  if (p.role !== 'user') return null;
  const text = textOf(p.content);
  if (!isHumanText(text)) return null;
  return { kind: 'prompt', text, ts: o.timestamp, session: state.session, project: state.project };
}

async function scanFile(entry, prev, found) {
  const { file, source } = entry;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (prev && prev.size === stat.size) return prev;
  const start = prev && prev.size < stat.size ? prev.size : 0;
  const state = {
    sawAssistant: prev && start ? !!prev.sawAssistant : false,
    project: prev && start ? prev.project || null : null,
    session: source === 'codex' ? (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/) || [])[1] || path.basename(file) : null,
  };
  let offset = start;
  for await (const { line, offset: next } of lines(file, start)) {
    offset = next;
    const ev = source === 'codex' ? parseCodex(line, state) : parseClaude(line, state);
    if (!ev) continue;
    if (ev.kind === 'assistant' || ev.kind === 'tool') {
      state.sawAssistant = true;
      if (ev.kind === 'tool') state.lastTool = ev;
      continue;
    }
    if (ev.kind === 'interrupt' || ev.kind === 'rejection') {
      state.redirect = true;
      const t = state.lastTool;
      // A rejected shell command is a grudge on its own: "don't run that without asking."
      if (ev.kind === 'rejection' && t && t.name === 'Bash' && t.command) {
        const head = commandHead(t.command);
        found.examples.push({
          ...ev,
          text: `[rejected] ${t.command.slice(0, 200)}`,
          rule: `Don't run \`${head}\` without approval`,
          source,
          exactTs: true,
          project: ev.project || state.project,
        });
      }
      continue;
    }
    if (!state.sawAssistant) continue; // first prompt is a request, not a correction
    if (source === 'claude' && ev.project) state.project = ev.project;
    const redirect = state.redirect;
    state.redirect = false;
    const correction = isCorrection(ev.text, { redirect });
    found.prompts.push({ week: weekOf(ev.ts), correction });
    if (correction) found.examples.push({ ...ev, rule: extractRule(ev.text), source, exactTs: true, project: ev.project || state.project });
  }
  return { size: offset, sawAssistant: state.sawAssistant, project: state.project };
}

const LOCK = path.join(store.HOME, 'scan.lock');

function lock() {
  try {
    fs.mkdirSync(store.HOME, { recursive: true });
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 10 * 60 * 1000) return false;
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

function unlock() {
  try {
    fs.unlinkSync(LOCK);
  } catch {}
}

async function scan({ full = false, onProgress } = {}) {
  if (!lock()) return { locked: true };
  try {
    const before = store.load();
    const entries = [...listClaude(), ...listCodex()];
    const found = { prompts: [], examples: [] };
    const fileUpdates = {};
    let i = 0;
    for (const e of entries) {
      const prev = full ? null : before.files[e.file];
      const next = await scanFile(e, prev, found);
      if (next) fileUpdates[e.file] = next;
      if (onProgress && ++i % 25 === 0) onProgress(i, entries.length);
    }
    // Reload before writing so live hook writes made during the scan survive.
    const db = store.load();
    if (full) {
      db.weeks = {};
      db.files = {};
    }
    Object.assign(db.files, fileUpdates);
    for (const p of found.prompts) {
      if (!p.week) continue;
      const w = (db.weeks[p.week] = db.weeks[p.week] || { prompts: 0, corrections: 0 });
      w.prompts++;
      if (p.correction) w.corrections++;
    }
    let added = 0;
    for (const ex of found.examples) if (store.addExample(db, ex)) added++;
    db.lastScan = new Date().toISOString();
    store.save(db);
    const sessionsSeen = new Set(entries.map((e) => e.file)).size;
    return {
      db,
      files: sessionsSeen,
      bySource: entries.reduce((m, e) => ((m[e.source] = (m[e.source] || 0) + 1), m), {}),
      newPrompts: found.prompts.length,
      newCorrections: found.examples.length,
      added,
    };
  } finally {
    unlock();
  }
}

module.exports = {
  scan,
  weekOf,
  parseClaude,
  parseCodex,
  textOf,
  isHumanText,
  lines,
  listClaude,
  listCodex,
  toolResultText,
  REJECTED,
  INTERRUPTED,
};
