'use strict';

// Step 3 (refine): a deep-scan preference like "write naturally, avoid AI
// prose" is true, but only in some situations (outreach, resumes), not when
// writing commit messages. Re-read the original moments with their context and
// rewrite each preference as a scoped rule: WHEN it applies, WHAT to do, and
// WHERE it belongs (global vs. one project). Also check what's already in the
// user's CLAUDE.md files so we don't repeat it.
//
// Step 4 (claudeMd): turn the scoped rules into a managed block in the right
// CLAUDE.md files. Preview by default; write only when asked, with a backup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const { collect, claude, pool } = require('./deep');

const HOME = os.homedir();
const GLOBAL_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const START = '<!-- grudge:start -->';
const END = '<!-- grudge:end -->';

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// The CLAUDE.md files Claude Code would load for a project directory.
function projectMd(cwd) {
  if (!cwd || cwd === HOME) return '';
  return [path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')].map(read).join('\n').trim();
}

const stripBlock = (s) => s.replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`, 'g'), '').trim();

function mostCommon(xs) {
  const m = new Map();
  for (const x of xs) if (x) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

const SYSTEM = `You turn preferences that were inferred from a developer's conversations with their AI coding agent into well-scoped CLAUDE.md rules.

Each preference comes with the moments it was inferred from: the task, what the agent had just said/done, and what the user replied. The inferred rule is often TOO BROAD. Your job is to put it back in context:

- Work out WHEN it actually applies from the evidence (kind of task, kind of output, project). Name the situation concretely, e.g. "When drafting outreach messages, cover letters, or resume bullets", not "When writing".
- Make the rule specific and actionable. Reuse the user's own sharp phrasing where it helps ("no slick one-liners about the company").
- Split into separate rules if the evidence shows genuinely different situations. Drop it (keep=false) if the moments are really just ordinary requests, one-off task decisions, or don't support a durable preference.
- scope = "global" if it holds across projects or kinds of work; "project" if the evidence is confined to one project (name it in "project").
- If the user's existing CLAUDE.md already says this, set already_covered=true and put the matching line in covered_by.
- Never invent preferences the evidence doesn't show.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          keep: { type: 'boolean' },
          reason: { type: 'string' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                when: { type: 'string' },
                rule: { type: 'string' },
                scope: { type: 'string', enum: ['global', 'project'] },
                project: { type: 'string' },
                already_covered: { type: 'boolean' },
                covered_by: { type: 'string' },
              },
              required: ['when', 'rule', 'scope', 'already_covered'],
            },
          },
        },
        required: ['id', 'keep', 'reason', 'rules'],
      },
    },
  },
  required: ['results'],
};

async function refine({ model = 'sonnet', minSessions = 2, log = () => {} } = {}) {
  const db = store.load();
  const groups = db.grudges.filter((g) => g.deep && g.status === 'active' && g.sessionIds.length >= minSessions);
  if (!groups.length) throw new Error('no deep-scan preferences to refine yet. Run `grudge scan --deep` first.');

  log('re-reading the original moments…');
  const turns = await collect();
  const at = new Map(turns.map((t) => [`${t.session}|${t.ts}`, t]));

  const globalMd = stripBlock(read(GLOBAL_MD));
  const projectCwd = {};
  for (const g of groups) for (const e of g.examples) if (e.project) (projectCwd[e.project] = projectCwd[e.project] || []).push(e.cwd || at.get(`${e.session}|${e.ts}`)?.cwd);
  for (const p of Object.keys(projectCwd)) projectCwd[p] = mostCommon(projectCwd[p]);

  const payload = (g) => ({
    id: g.id,
    inferred_rule: g.rule,
    sessions: g.sessionIds.length,
    moments: g.examples.slice(-6).map((e) => {
      const t = at.get(`${e.session}|${e.ts}`) || {};
      return { project: e.project, task: t.task, agent_said: t.agentSaid, agent_did: t.agentDid, user: t.user || e.context || e.text };
    }),
  });

  const batches = [];
  for (let i = 0; i < groups.length; i += 4) batches.push(groups.slice(i, i + 4));
  log(`${groups.length} preferences → ${batches.length} ${model} calls`);

  let cost = 0;
  let done = 0;
  const byId = new Map(groups.map((g) => [g.id, g]));
  await pool(batches, 3, async (batch) => {
    const projects = [...new Set(batch.flatMap((g) => g.examples.map((e) => e.project)).filter(Boolean))];
    const existing = { global: globalMd };
    for (const p of projects) {
      const md = stripBlock(projectMd(projectCwd[p]));
      if (md) existing[p] = md.slice(0, 6000);
    }
    const input = { existing_claude_md: existing, preferences: batch.map(payload) };
    try {
      const { data, cost: c } = await claude(JSON.stringify(input), { system: SYSTEM, schema: SCHEMA, model });
      cost += c;
      for (const r of data.results || []) {
        const g = byId.get(r.id);
        if (!g) continue;
        g.refined = { keep: r.keep, reason: r.reason, rules: r.keep ? r.rules : [], model, at: new Date().toISOString() };
      }
    } catch (e) {
      log(`  batch failed: ${e.message}`);
    }
    log(`  refined ${++done}/${batches.length} · $${cost.toFixed(2)}`);
  });

  db.projectCwd = Object.assign(db.projectCwd || {}, projectCwd);
  delete db.consolidated; // stale now
  store.save(db);
  return { groups, cost };
}

// Every kept, scoped rule with where it should live.
function scopedRules(db) {
  const out = [];
  for (const g of db.grudges) {
    if (!g.deep || g.status !== 'active' || !g.refined || !g.refined.keep) continue;
    for (const r of g.refined.rules) {
      const cwd = r.scope === 'project' ? (db.projectCwd || {})[r.project] : null;
      const global = r.scope === 'global' || !cwd || cwd === HOME;
      out.push({ ...r, grudge: g.id, sessions: g.sessionIds.length, target: global ? GLOBAL_MD : path.join(cwd, 'CLAUDE.md'), global });
    }
  }
  return out.sort((a, b) => b.sessions - a.sessions);
}

// ---------- consolidation: merge, route, and trim before touching any file ----------

// Places a rule could live: the global CLAUDE.md (every session), a repo's
// CLAUDE.md, or a user skill's SKILL.md (loaded only when that skill runs).
function targets(db) {
  const out = [{ id: 'global', path: GLOBAL_MD, kind: 'global', about: 'Loaded into EVERY session. Only universal habits belong here.' }];
  const seen = new Set();
  const addRepo = (dir) => {
    if (!dir || dir === HOME || seen.has(dir)) return;
    seen.add(dir);
    let about = '';
    for (const f of ['CLAUDE.md', 'README.md']) {
      const s = read(path.join(dir, f));
      if (s) {
        about = s.replace(/\s+/g, ' ').slice(0, 240);
        break;
      }
    }
    out.push({ id: `repo:${path.basename(dir)}`, path: path.join(dir, 'CLAUDE.md'), kind: 'repo', about: about || `repo at ${dir.replace(HOME, '~')}` });
  };
  for (const dir of Object.values(db.projectCwd || {})) addRepo(dir);
  // Sibling repos in the folders the user works from (e.g. a resume repo they edit from ~).
  for (const root of new Set(Object.values(db.projectCwd || {}).filter(Boolean).map((d) => path.dirname(d)).concat([path.join(HOME, 'Documents', 'workplace')]))) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'README.md'))) addRepo(dir);
      if (out.length > 60) break;
    }
  }
  const skillsDir = path.join(HOME, '.claude', 'skills');
  let skills = [];
  try {
    skills = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {}
  for (const s of skills) {
    const p = path.join(skillsDir, s.name, 'SKILL.md');
    const md = read(p);
    if (!md) continue;
    const desc = (md.match(/^description:\s*(.+)$/m) || [])[1] || md.slice(0, 200);
    out.push({ id: `skill:${s.name}`, path: p, kind: 'skill', about: desc.slice(0, 300) });
  }
  return out;
}

const CONSOLIDATE_SYSTEM = `You're finalizing rules (learned from a developer's repeated corrections to their AI coding agent) before they're written into instruction files. Each target file has a cost: the global CLAUDE.md is loaded into every single session, so it must stay small.

Do three things:
1. MERGE rules that overlap or address the same situation into one tight rule. Keep concrete specifics (e.g. "no em dashes", "IC means individual contributor").
2. ROUTE each rule to the most specific target that will be loaded when it matters:
   - a repo's CLAUDE.md if the rule is about work in that repo (e.g. resume rules -> the resume repo, even if the sessions ran from the home folder),
   - a skill's SKILL.md if the rule is about exactly what that skill does (e.g. outreach-writing rules -> an outreach skill),
   - global ONLY for habits that apply across most work (how to communicate, when to ask before acting, safety).
3. TRIM: each rule is "when" (short situation, max 12 words) + "rule" (max 35 words). At most 8 rules in global. Drop anything too task-specific to matter again.

Use only the target ids given. Every input rule index must be used in some output rule or listed in "dropped".`;

const CONSOLIDATE_SCHEMA = {
  type: 'object',
  properties: {
    placements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: { when: { type: 'string' }, rule: { type: 'string' }, from: { type: 'array', items: { type: 'integer' } } },
              required: ['when', 'rule', 'from'],
            },
          },
        },
        required: ['target', 'rules'],
      },
    },
    dropped: { type: 'array', items: { type: 'integer' } },
  },
  required: ['placements', 'dropped'],
};

// Claude Code's own auto memory (~/.claude/projects/<p>/memory/*.md). We don't
// want to restate what it already saved. Only short excerpts are passed along.
function autoMemory(limit = 40) {
  const root = path.join(HOME, '.claude', 'projects');
  const notes = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {}
  for (const d of dirs) {
    const dir = path.join(root, d, 'memory');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      continue;
    }
    for (const f of files) {
      const body = read(path.join(dir, f)).replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim();
      if (body) notes.push({ file: `${d}/memory/${f}`, excerpt: body.slice(0, 400) });
      if (notes.length >= limit) return notes;
    }
  }
  return notes;
}

const CONSOLIDATE_MEMORY_NOTE = `
"auto_memory" lists notes Claude Code already saved to itself and loads automatically. If a rule just restates one of those notes, drop it (add its index to "dropped"); if it sharpens one, keep the sharper rule.`;

async function consolidate(db, { model = 'sonnet' } = {}) {
  const rules = scopedRules(db).filter((r) => !r.already_covered);
  if (!rules.length) throw new Error('no refined rules yet. Run `grudge refine` first.');
  const tg = targets(db);
  const input = {
    auto_memory: autoMemory(),
    targets: tg.map(({ id, kind, about }) => ({ id, kind, about })),
    rules: rules.map((r, i) => ({ i, when: r.when, rule: r.rule, sessions: r.sessions, suggested_scope: r.global ? 'global' : r.project })),
  };
  const { data, cost } = await claude(JSON.stringify(input), { system: CONSOLIDATE_SYSTEM + CONSOLIDATE_MEMORY_NOTE, schema: CONSOLIDATE_SCHEMA, model });
  const byId = new Map(tg.map((t) => [t.id, t]));
  const placements = [];
  for (const p of data.placements || []) {
    const t = byId.get(p.target);
    if (!t || !p.rules.length) continue;
    placements.push({
      target: t.id,
      kind: t.kind,
      path: t.path,
      rules: p.rules.map((r) => ({
        when: r.when,
        rule: r.rule,
        sessions: Math.max(0, ...r.from.map((i) => (rules[i] ? rules[i].sessions : 0))),
        from: r.from,
      })),
    });
  }
  db.consolidated = { at: new Date().toISOString(), model, placements, dropped: (data.dropped || []).map((i) => rules[i] && rules[i].when).filter(Boolean) };
  store.save(db);
  return { cost, placements, dropped: db.consolidated.dropped, inputRules: rules.length };
}

function line(r) {
  const when = r.when.replace(/[.:,\s]+$/, '');
  return `- **${when}:** ${r.rule.replace(/\s+$/, '')}`;
}

function block(rules) {
  return [
    START,
    '## Learned preferences',
    '',
    '_Inferred by [grudge](https://github.com/dimucciojonathan/grudge) from corrections I made in more than one session. Edit freely; rerun `grudge claude-md --write` to refresh._',
    '',
    ...rules.map(line),
    END,
  ].join('\n');
}

function plan(db) {
  const byTarget = new Map();
  if (db.consolidated) {
    for (const p of db.consolidated.placements) byTarget.set(p.path, p.rules);
  } else {
    for (const r of scopedRules(db).filter((x) => !x.already_covered)) {
      if (!byTarget.has(r.target)) byTarget.set(r.target, []);
      byTarget.get(r.target).push(r);
    }
  }
  return [...byTarget.entries()].map(([target, rs]) => {
    const current = read(target);
    const b = block(rs);
    const next = current.includes(START)
      ? current.replace(new RegExp(`${START}[\\s\\S]*?${END}`), b)
      : (current.trimEnd() ? current.trimEnd() + '\n\n' : '') + b + '\n';
    return { target, rules: rs, current, next, replacing: current.includes(START) };
  });
}

function write(changes) {
  const dir = path.join(store.HOME, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written = [];
  for (const c of changes) {
    if (c.current) {
      const bak = path.join(dir, `${stamp}${c.target.replace(/[\\/]/g, '_')}`);
      fs.writeFileSync(bak, c.current);
      c.backup = bak;
    }
    fs.mkdirSync(path.dirname(c.target), { recursive: true });
    fs.writeFileSync(c.target, c.next);
    written.push(c);
  }
  return written;
}

module.exports = { refine, consolidate, targets, autoMemory, scopedRules, plan, write, line, GLOBAL_MD };
