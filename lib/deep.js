'use strict';

// Deep scan: instead of regexes, a small model reads every follow-up message
// together with what the agent had just done, and decides whether it reveals
// a durable preference, however indirectly it was phrased. A second pass
// groups the same preference said different ways.
//
// Runs through the user's own `claude` CLI (headless, no tools, no session
// persistence), so no API key is needed.

const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { lines, listClaude, listCodex, textOf, isHumanText, toolResultText, REJECTED, INTERRUPTED } = require('./scan');
const store = require('./store');

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function toolSummary(name, input) {
  const i = input || {};
  const arg = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || '';
  return clip(`${name}${arg ? ': ' + arg : ''}`, 120);
}

// ---------- 1. collect turns: (what the agent just did) → (what the human said) ----------

async function collectFile({ file, source }, out, seen) {
  const session =
    source === 'codex'
      ? (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/) || [])[1] || path.basename(file)
      : path.basename(file, '.jsonl');
  const st = { first: null, project: null, cwd: null, said: '', tools: [], interrupted: false, rejected: false, sawAssistant: false, sdk: false };
  const reset = () => {
    st.said = '';
    st.tools = [];
    st.interrupted = false;
    st.rejected = false;
  };
  const emit = (text, ts) => {
    if (!st.sawAssistant) {
      st.first = st.first || text;
      return;
    }
    const k = crypto.createHash('sha1').update(clip(text, 400) + '|' + clip(st.said, 200)).digest('hex');
    if (!seen.has(k)) {
      seen.add(k);
      out.push({
        id: `t${out.length + 1}`,
        session,
        project: st.project,
        cwd: st.cwd,
        ts,
        task: clip(st.first, 200),
        agentSaid: clip(st.said.slice(-700), 500),
        agentDid: st.tools.slice(-6),
        interrupted: st.interrupted,
        rejected: st.rejected,
        user: clip(text, 700),
      });
    }
    reset();
  };

  for await (const { line } of lines(file, 0)) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (source === 'codex') {
      const p = o.payload || {};
      if (o.type === 'session_meta' && p.cwd) {
        st.project = path.basename(p.cwd);
        st.cwd = p.cwd;
      }
      if (o.type !== 'response_item') continue;
      if (p.type === 'function_call') {
        let args = {};
        try {
          args = JSON.parse(p.arguments || '{}');
        } catch {}
        st.tools.push(toolSummary(p.name, args));
        st.sawAssistant = true;
      } else if (p.type === 'message' && p.role === 'assistant') {
        st.said = textOf(p.content.map((c) => ({ ...c, type: 'text' }))) || st.said;
        st.sawAssistant = true;
      } else if (p.type === 'message' && p.role === 'user') {
        const t = textOf(p.content);
        if (isHumanText(t)) emit(t, o.timestamp);
      }
      continue;
    }
    if (o.isSidechain) continue;
    if (o.cwd) {
      st.project = path.basename(o.cwd);
      st.cwd = o.cwd;
    }
    if (o.type === 'assistant') {
      const content = (o.message && o.message.content) || [];
      if (!Array.isArray(content)) continue;
      st.sawAssistant = true;
      const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) st.said = text;
      for (const c of content) if (c && c.type === 'tool_use') st.tools.push(toolSummary(c.name, c.input));
      continue;
    }
    if (o.type !== 'user' || o.isMeta || o.isCompactSummary) continue;
    if (o.promptSource === 'sdk' || String(o.entrypoint || '').startsWith('sdk')) {
      st.sdk = true;
      continue;
    }
    const content = o.message && o.message.content;
    if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result' && toolResultText(c).startsWith(REJECTED))) {
      st.rejected = true;
      continue;
    }
    const t = textOf(content);
    if (t && t.trimStart().startsWith(INTERRUPTED)) {
      st.interrupted = true;
      continue;
    }
    if (isHumanText(t)) emit(t, o.timestamp);
  }
}

async function collect({ days } = {}) {
  const out = [];
  const seen = new Set();
  const since = days ? Date.now() - days * 86400000 : 0;
  for (const e of [...listClaude(), ...listCodex()]) await collectFile(e, out, seen);
  return out.filter((t) => !since || new Date(t.ts).getTime() >= since);
}

// ---------- 2. model calls ----------

function claude(prompt, { system, schema, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', model,
      '--tools', '',
      '--no-session-persistence',
      '--safe-mode',
      '--output-format', 'json',
      '--system-prompt', system,
      '--json-schema', JSON.stringify(schema),
    ];
    const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`could not run \`claude\`: ${e.message}`)));
    child.on('close', (code) => {
      try {
        const r = JSON.parse(out);
        if (r.is_error || !r.structured_output) throw new Error(r.result || 'no structured output');
        resolve({ data: r.structured_output, cost: r.total_cost_usd || 0 });
      } catch (e) {
        reject(new Error(`claude exited ${code}: ${clip(err || out || e.message, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

const FIND_SYSTEM = `You analyze one developer's conversations with an AI coding agent (Claude Code or Codex).
You'll get "turns": what the agent had just said and done, then what the human typed next.

Find every turn where the human's message reveals a DURABLE preference about how the agent should work for them, i.e. something a good assistant would remember for next week, not just for this task.

Be generous with indirect signals. People rarely say "no, don't". They say things like:
- re-asking or rephrasing what they already asked (the first answer missed)
- narrowing: "just give me the command", "only the first part", "the short version"
- asking for less or more: "can we simplify", "what's the TL;DR", "more detail on X only"
- picking an earlier version: "the previous one was better"
- questioning a choice: "why is this so long?", "do we need all these files?", "is that necessary?"
- doing it themselves or undoing the agent's work
- interrupting (interrupted=true) or rejecting a tool call (rejected=true), then redirecting
- adding a constraint that implies the agent overstepped: "propose first", "commit locally only", "don't touch X"
- tone or format nudges: "in paragraphs", "no headers", "be direct", "less hedging"
- frustration or confusion: "hm", "that's not what I meant", "I'm lost"

Skip: ordinary next tasks, answers to the agent's questions, approvals, and one-off factual fixes about the task's content (e.g. "the endpoint is /v2, not /v1"), UNLESS they generalize (e.g. "don't invent numbers I didn't give you" is durable).

For each finding write "rule": a short, general, imperative instruction to the agent for future sessions (max ~18 words, no task-specific nouns unless the preference is inherently about them). "quote": the human's key words, verbatim, max 15 words. "confidence": 0-1 that this is a durable preference.`;

const FIND_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'string' },
          rule: { type: 'string' },
          quote: { type: 'string' },
          signal: { type: 'string', enum: ['explicit', 'indirect'] },
          confidence: { type: 'number' },
        },
        required: ['turn', 'rule', 'quote', 'signal', 'confidence'],
      },
    },
  },
  required: ['findings'],
};

const GROUP_SYSTEM = `You get preferences a developer expressed to their AI coding agent, extracted from many sessions. Group the ones that express the SAME underlying preference even when worded differently ("more concise" and "way too long" are one group). Don't force unrelated items together. Give each group one clean canonical rule: imperative, specific, max ~15 words. Every input id must appear in exactly one group; singletons are fine.`;

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { rule: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } },
        required: ['rule', 'ids'],
      },
    },
  },
  required: ['groups'],
};

function batches(turns, maxTurns = 25, maxChars = 24000) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const t of turns) {
    const s = JSON.stringify(t).length;
    if (cur.length && (cur.length >= maxTurns || size + s > maxChars)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- 3. run ----------

async function deepScan({ model = 'haiku', days, concurrency = 4, minConfidence = 0.6, log = () => {} } = {}) {
  log('collecting turns…');
  const turns = await collect({ days });
  const byId = new Map(turns.map((t) => [t.id, t]));
  const work = batches(turns);
  log(`${turns.length} follow-up messages in ${new Set(turns.map((t) => t.session)).size} sessions → ${work.length} ${model} calls`);
  let cost = 0;
  let done = 0;
  const found = [];
  await pool(work, concurrency, async (batch) => {
    const payload = batch.map(({ id, task, agentSaid, agentDid, interrupted, rejected, user }) => ({
      id,
      task,
      agentSaid,
      agentDid,
      ...(interrupted ? { interrupted } : {}),
      ...(rejected ? { rejected } : {}),
      user,
    }));
    try {
      const { data, cost: c } = await claude(JSON.stringify(payload), { system: FIND_SYSTEM, schema: FIND_SCHEMA, model });
      cost += c;
      for (const f of data.findings || []) if (byId.has(f.turn) && f.confidence >= minConfidence) found.push(f);
    } catch (e) {
      log(`  batch failed: ${e.message}`);
    }
    log(`  read ${++done}/${work.length} batches · ${found.length} preferences so far · $${cost.toFixed(2)}`);
  });

  if (!found.length) return { turns: turns.length, findings: 0, groups: [], cost };

  log('grouping…');
  found.forEach((f, i) => (f.fid = `f${i + 1}`));
  const listing = found.map((f) => ({ id: f.fid, rule: f.rule, quote: f.quote }));
  let groups;
  try {
    const { data, cost: c } = await claude(JSON.stringify(listing), { system: GROUP_SYSTEM, schema: GROUP_SCHEMA, model });
    cost += c;
    groups = data.groups;
  } catch (e) {
    log(`  grouping failed (${e.message}); keeping findings ungrouped`);
    groups = found.map((f) => ({ rule: f.rule, ids: [f.fid] }));
  }

  // Write deep grudges, replacing the previous deep run.
  const byFid = new Map(found.map((f) => [f.fid, f]));
  const db = store.load();
  db.grudges = db.grudges.filter((g) => !g.deep);
  const assigned = new Set();
  const out = [];
  for (const grp of groups) {
    const members = (grp.ids || []).map((id) => byFid.get(id)).filter((f) => f && !assigned.has(f.fid));
    if (!members.length) continue;
    members.forEach((f) => assigned.add(f.fid));
    const ex = members.map((f) => {
      const t = byId.get(f.turn);
      return {
        rule: f.rule,
        text: f.quote,
        context: t.user,
        project: t.project,
        cwd: t.cwd,
        session: t.session,
        ts: t.ts,
        source: 'deep',
        signal: f.signal,
      };
    });
    ex.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const g = {
      id: `d${db.nextId++}`,
      deep: true,
      rule: grp.rule,
      custom: null,
      status: 'active',
      examples: ex.slice(-20),
      sessionIds: [...new Set(ex.map((e) => e.session))],
      count: ex.length,
      indirect: ex.filter((e) => e.signal === 'indirect').length,
      firstSeen: ex[0].ts,
      lastSeen: ex[ex.length - 1].ts,
    };
    db.grudges.push(g);
    out.push(g);
  }
  db.deepAt = new Date().toISOString();
  db.deepModel = model;
  store.save(db);
  out.sort((a, b) => b.sessionIds.length - a.sessionIds.length || b.count - a.count);
  return { turns: turns.length, findings: found.length, groups: out, cost };
}

module.exports = { deepScan, collect, batches, claude, pool };
