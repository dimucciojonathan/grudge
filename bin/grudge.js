#!/usr/bin/env node
'use strict';

const store = require('../lib/store');

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1);
const dim = c(2);
const red = c(31);
const yellow = c(33);
const cyan = c(36);

const REPO = 'github.com/dimucciojonathan/grudge';

function ago(ts) {
  if (!ts) return '?';
  const d = (Date.now() - new Date(ts)) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 60) return `${Math.floor(d)} days ago`;
  return `${Math.floor(d / 30)} months ago`;
}

function ranked(db, all) {
  return db.grudges
    .filter((g) => g.status === 'active' && (all || store.sessions(g) >= 2))
    .sort((a, b) => store.sessions(b) - store.sessions(a) || b.count - a.count);
}

function printList(db, { all = false, limit = 15 } = {}) {
  const list = ranked(db, all).slice(0, limit);
  if (!list.length) {
    console.log(dim(all ? '  No grudges yet.' : '  Nothing you’ve had to say twice. Yet.'));
    return;
  }
  const w = String(list.length).length;
  list.forEach((g, i) => {
    const n = store.sessions(g);
    const times = n >= 5 ? red(`×${n}`) : yellow(`×${n}`);
    console.log(`  ${String(i + 1).padStart(w)}. ${times} ${bold(store.display(g))} ${dim(`[${g.id}]`)}`);
    console.log(`  ${' '.repeat(w)}     ${dim(`${store.projects(g).join(', ') || '—'} · last: ${ago(g.lastSeen)}`)}`);
  });
}

function totals(db) {
  let prompts = 0;
  let corrections = 0;
  for (const w of Object.values(db.weeks)) {
    prompts += w.prompts;
    corrections += w.corrections;
  }
  return { prompts, corrections };
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function cmdDeep(args) {
  const { deepScan } = require('../lib/deep');
  const model = flag(args, '--model', 'haiku');
  const days = Number(flag(args, '--days', 0)) || undefined;
  const r = await deepScan({ model, days, log: (m) => console.error(dim(`  ${m}`)) });
  const repeated = r.groups.filter((g) => store.sessions(g) >= 2);
  console.log();
  console.log(`  ${bold('grudge --deep')} ${dim(`· ${model} read ${r.turns} of your follow-up messages · $${r.cost.toFixed(2)}`)}`);
  console.log();
  console.log(`  It found ${bold(r.findings)} moments you steered your agent, ${bold(r.groups.reduce((a, g) => a + g.indirect, 0))} of them indirectly.`);
  console.log(`  ${bold(repeated.length)} preferences came up in more than one session:`);
  console.log();
  const w = String(repeated.length).length;
  repeated.slice(0, 20).forEach((g, i) => {
    const n = store.sessions(g);
    console.log(`  ${String(i + 1).padStart(w)}. ${n >= 4 ? red(`×${n}`) : yellow(`×${n}`)} ${bold(g.rule)} ${dim(`[${g.id}]`)}`);
    const quotes = [...new Set(g.examples.map((e) => e.text))].slice(-3).map((q) => `"${q}"`);
    console.log(`  ${' '.repeat(w)}     ${dim(quotes.join('  '))}`);
  });
  const once = r.groups.length - repeated.length;
  if (once) console.log(dim(`\n  …plus ${once} preferences you've only said once so far (grudge list --all).`));
  console.log();
  if (repeated.length) {
    console.log(dim(`  Next: put each one back in context so it isn't too broad:  ${cyan('grudge refine')}`));
    console.log();
  }
}

async function cmdRefine(args) {
  const { refine, scopedRules } = require('../lib/refine');
  const model = flag(args, '--model', 'sonnet');
  const { groups, cost } = await refine({ model, log: (m) => console.error(dim(`  ${m}`)) });
  const db = store.load();
  const rules = scopedRules(db);
  const dropped = groups.filter((g) => store.get(db, g.id)?.refined && !store.get(db, g.id).refined.keep);
  console.log();
  console.log(`  ${bold('grudge refine')} ${dim(`· ${model} put ${groups.length} preferences back in context · $${cost.toFixed(2)}`)}`);
  console.log();
  const show = (r) => {
    const where = r.global ? 'global' : r.project;
    const tag = r.already_covered ? dim(' (already in your CLAUDE.md)') : '';
    console.log(`  ${yellow(`×${r.sessions}`)} ${bold(r.when.replace(/[.:,\s]+$/, ''))} ${dim(`· ${where}`)}${tag}`);
    console.log(`       ${r.rule}`);
  };
  rules.forEach(show);
  if (dropped.length) {
    console.log();
    console.log(dim(`  Dropped ${dropped.length} that didn't hold up in context:`));
    for (const g of dropped) console.log(dim(`    – ${g.rule}  (${store.get(db, g.id).refined.reason})`));
  }
  console.log();
  console.log(dim(`  Next: preview the CLAUDE.md changes:  ${cyan('grudge claude-md')}`));
  console.log();
}

async function cmdClaudeMd(args) {
  const { plan, write, line, consolidate } = require('../lib/refine');
  let db = store.load();
  if (!db.consolidated || args.includes('--refresh')) {
    const model = flag(args, '--model', 'sonnet');
    console.error(dim(`  merging, routing, and trimming rules with ${model}…`));
    const r = await consolidate(db, { model });
    const out = r.placements.reduce((a, p) => a + p.rules.length, 0);
    console.error(dim(`  ${r.inputRules} rules → ${out} across ${r.placements.length} files · $${r.cost.toFixed(2)}`));
    if (r.dropped.length) console.error(dim(`  dropped as too specific: ${r.dropped.join('; ')}`));
    db = store.load();
  }
  const changes = plan(db);
  if (!changes.length) return fail('nothing to write. Run `grudge scan --deep` and `grudge refine` first.');
  const doWrite = args.includes('--write');
  console.log();
  for (const c of changes) {
    const verb = c.replacing ? 'update the grudge block in' : c.current ? 'append to' : 'create';
    const label = doWrite ? `Writing (${verb})` : `Would ${verb}`;
    console.log(`  ${bold(label)} ${cyan(c.target.replace(require('os').homedir(), '~'))}`);
    for (const r of c.rules) console.log(`  ${'+'} ${line(r)}`);
    console.log();
  }
  if (!doWrite) {
    console.log(dim(`  Nothing written yet. Apply with:  ${cyan('grudge claude-md --write')}  (backups go to ~/.grudge/backups)`));
    console.log();
    return;
  }
  for (const c of write(changes)) if (c.backup) console.log(dim(`  backup: ${c.backup}`));
  console.log(dim('  Done. Rerun anytime; grudge only ever replaces its own block.'));
  console.log();
}

async function cmdScan(args) {
  if (args.includes('--deep')) return cmdDeep(args);
  const { scan } = require('../lib/scan');
  const quiet = args.includes('--quiet');
  const json = args.includes('--json');
  const progress = !quiet && !json && process.stderr.isTTY;
  if (progress) process.stderr.write(dim('  reading your agent history…\r'));
  const r = await scan({
    full: args.includes('--full'),
    onProgress: !progress ? null : (i, n) => process.stderr.write(dim(`  reading your agent history… ${i}/${n}\r`)),
  });
  if (r.locked) {
    if (!quiet) console.error('  a scan is already running; try again in a minute.');
    return;
  }
  if (quiet) return;
  const db = r.db;
  const { prompts, corrections } = totals(db);
  const repeated = ranked(db, false);
  if (json) {
    console.log(JSON.stringify({ sessions: r.files, bySource: r.bySource, prompts, corrections, repeated: repeated.length }, null, 2));
    return;
  }
  if (progress) process.stderr.write(' '.repeat(60) + '\r');
  const src = Object.entries(r.bySource).map(([k, v]) => `${k === 'claude' ? 'Claude Code' : 'Codex'} ${v}`).join(', ');
  console.log();
  console.log(`  ${bold('grudge')} ${dim(`· ${r.files} sessions (${src || 'none found'})`)}`);
  console.log();
  if (!corrections) {
    console.log('  No corrections found. Either your agent is perfect or you are very patient.');
    return;
  }
  const pct = prompts ? Math.round((corrections / prompts) * 100) : 0;
  console.log(`  You corrected your agent ${bold(red(corrections))} times ${dim(`(${pct}% of your follow-up messages)`)}.`);
  if (!repeated.length) {
    console.log('  None of them repeated across sessions. Yet.');
    console.log(dim(`  Install the plugin and grudge starts keeping score:  ${cyan('/plugin marketplace add dimucciojonathan/grudge')}`));
    console.log(dim(`  See every correction so far:  ${cyan('grudge list --all')}`));
    console.log();
    return;
  }
  console.log(`  ${bold(repeated.length)} of those were things you'd already said in another session:`);
  console.log();
  printList(db);
  console.log();
  console.log(dim('  Claude forgets. grudge never does. From now on, every session starts knowing these.'));
  console.log(dim(`  Clean them up into CLAUDE.md rules:  ${cyan('/grudge')} in Claude Code, or ${cyan('grudge export')}`));
  console.log(dim(`  Wrong one?  ${cyan('grudge forgive <id>')}`));
  console.log();
  console.log(dim(`  share: "I've corrected my AI ${corrections} times. ${repeated.length} of them more than once. ${REPO}"`));
  console.log();
}

function cmdList(args) {
  const db = store.load();
  const all = args.includes('--all');
  if (args.includes('--json')) {
    const list = ranked(db, all).map((g) => ({
      id: g.id,
      rule: store.display(g),
      raw: g.rule,
      sessions: store.sessions(g),
      count: g.count,
      projects: store.projects(g),
      lastSeen: g.lastSeen,
      examples: g.examples.slice(-5).map((e) => e.text),
    }));
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  printList(db, { all, limit: all ? 200 : 25 });
}

function cmdShow([id]) {
  const db = store.load();
  const g = store.get(db, id);
  if (!g) return fail(`no grudge ${id}`);
  console.log(`${bold(store.display(g))} ${dim(`[${g.id}] · ${store.sessions(g)} sessions · ${g.count} times · ${g.status}`)}`);
  for (const e of g.examples) console.log(`  ${dim(String(e.ts).slice(0, 10))} ${dim(e.project || '')}  ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

function mutate(fn) {
  const db = store.load();
  const msg = fn(db);
  store.save(db);
  if (msg) console.log(msg);
}

function fail(msg) {
  console.error(`grudge: ${msg}`);
  process.exitCode = 1;
}

function cmdRule([id, ...rest]) {
  const text = rest.join(' ').trim();
  if (!id || !text) return fail('usage: grudge rule <id> "<clean rule text>"');
  mutate((db) => {
    const g = store.get(db, id);
    if (!g) throw new Error(`no grudge ${id}`);
    g.custom = text;
    return `${id}: ${text}`;
  });
}

function cmdForgive(ids) {
  if (!ids.length) return fail('usage: grudge forgive <id> [id…]');
  mutate((db) => {
    for (const id of ids) {
      const g = store.get(db, id);
      if (g) g.status = 'forgiven';
    }
    return `forgiven: ${ids.join(', ')} ${dim('(grudge will not bring these up again)')}`;
  });
}

function cmdMerge([into, ...from]) {
  if (!into || !from.length) return fail('usage: grudge merge <into-id> <id> [id…]');
  mutate((db) => {
    const g = store.merge(db, into, from);
    return `merged into ${g.id}: ${store.display(g)} (${store.sessions(g)} sessions)`;
  });
}

function cmdExport() {
  const db = store.load();
  const list = ranked(db, false);
  if (!list.length) return fail('nothing to export yet. Run `grudge scan` first.');
  console.log('## Standing corrections (from grudge)\n');
  console.log("Things I've had to tell you in more than one session. Follow them without being asked.\n");
  for (const g of list) console.log(`- ${store.display(g)}`);
}

function cmdStats() {
  const db = store.load();
  const weeks = Object.keys(db.weeks).sort();
  if (!weeks.length) return fail('no data yet. Run `grudge scan` first.');
  console.log(dim('  week of       prompts  corrections  rate'));
  for (const w of weeks.slice(-16)) {
    const { prompts, corrections } = db.weeks[w];
    const rate = prompts ? ((corrections / prompts) * 100).toFixed(1) + '%' : '—';
    const mark = db.installedAt && w >= String(db.installedAt).slice(0, 10) ? cyan(' ●') : '';
    console.log(`  ${w}  ${String(prompts).padStart(7)}  ${String(corrections).padStart(11)}  ${rate.padStart(5)}${mark}`);
  }
  if (db.installedAt) {
    const cut = String(db.installedAt).slice(0, 10);
    const sum = (f) =>
      weeks.filter(f).reduce((a, w) => ({ p: a.p + db.weeks[w].prompts, c: a.c + db.weeks[w].corrections }), { p: 0, c: 0 });
    const b = sum((w) => w < cut);
    const a = sum((w) => w >= cut);
    const r = (x) => (x.p ? ((x.c / x.p) * 100).toFixed(1) + '%' : '—');
    console.log();
    console.log(`  correction rate before grudge: ${bold(r(b))}   since installing: ${bold(r(a))} ${dim('(● = after install)')}`);
  }
}

const HELP = `
  ${bold('grudge')} · Claude forgets. grudge never does.

  ${cyan('grudge scan')}             read your Claude Code + Codex history, find repeated corrections
  ${cyan('grudge scan --deep')}      have a small model (haiku) read every follow-up for indirect feedback
                          [--model haiku|sonnet] [--days N]. Uses your \`claude\` login.
  ${cyan('grudge list')} [--all]     what you keep having to say (--json for machines)
  ${cyan('grudge refine')}           put each deep-scan preference back in context: when it applies,
                          where it belongs, and whether your CLAUDE.md already says it
  ${cyan('grudge claude-md')}        preview the scoped rules as CLAUDE.md edits (--write to apply)
  ${cyan('grudge show')} <id>        the receipts
  ${cyan('grudge rule')} <id> "…"    rewrite a grudge as a clean rule
  ${cyan('grudge merge')} <id> <id>  these are the same complaint
  ${cyan('grudge forgive')} <id>     not a real grudge; never mention it again
  ${cyan('grudge export')}           CLAUDE.md snippet of your standing corrections
  ${cyan('grudge stats')}            correction rate by week, before vs. after grudge

  Install the Claude Code plugin so Claude remembers too:
    /plugin marketplace add dimucciojonathan/grudge
    /plugin install grudge@grudge
`;

async function main(argv) {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case undefined:
      case 'scan':
        return await cmdScan(args);
      case 'list':
        return cmdList(args);
      case 'show':
        return cmdShow(args);
      case 'rule':
        return cmdRule(args);
      case 'forgive':
        return cmdForgive(args);
      case 'merge':
        return cmdMerge(args);
      case 'export':
        return cmdExport();
      case 'refine':
        return await cmdRefine(args);
      case 'claude-md':
        return await cmdClaudeMd(args);
      case 'stats':
        return cmdStats();
      case 'hook':
        return require('../lib/hooks').run(args[0]);
      case 'help':
      case '--help':
      case '-h':
        return console.log(HELP);
      default:
        fail(`unknown command "${cmd}"`);
        console.log(HELP);
    }
  } catch (e) {
    fail(e.message);
  }
}

main(process.argv.slice(2));
