'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { tokens, similarity } = require('./detect');

const HOME = process.env.GRUDGE_HOME || path.join(os.homedir(), '.grudge');
const FILE = path.join(HOME, 'grudges.json');
const MATCH = 0.5;
const MAX_EXAMPLES = 20;

function empty() {
  return { version: 1, installedAt: null, nextId: 1, grudges: [], seen: {}, files: {}, weeks: {} };
}

function load() {
  try {
    return Object.assign(empty(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return empty();
  }
}

function save(db) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

function key(session, text) {
  const h = crypto.createHash('sha1').update(String(text).trim()).digest('hex').slice(0, 12);
  return `${session}:${h}`;
}

function sessions(g) {
  return g.sessionIds.length;
}

function projects(g) {
  return [...new Set(g.examples.map((e) => e.project).filter(Boolean))];
}

function display(g) {
  return g.custom || g.rule;
}

function findMatch(db, rule) {
  const t = tokens(rule);
  let best = null;
  let bestSim = 0;
  for (const g of db.grudges) {
    if (g.status === 'merged') continue;
    let s = similarity(t, tokens(display(g)));
    for (const e of g.examples.slice(-10)) s = Math.max(s, similarity(t, tokens(e.rule)));
    if (s > bestSim) {
      bestSim = s;
      best = g;
    }
  }
  return bestSim >= MATCH ? best : null;
}

// Returns the grudge the example landed in, or null if already recorded.
// Scanned examples carry the transcript's own timestamp, which resumed and
// forked sessions copy verbatim, so text+timestamp catches those duplicates.
function addExample(db, ex) {
  const keys = [key(ex.session, ex.text)];
  if (ex.ts && ex.exactTs) keys.push(key(`@${ex.ts}`, ex.text));
  if (keys.some((k) => db.seen[k])) {
    for (const k of keys) db.seen[k] = 1;
    return null;
  }
  for (const k of keys) db.seen[k] = 1;
  let g = findMatch(db, ex.rule);
  // Same words within minutes = a copied/imported session, not a repeat.
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
  if (g && g.examples.some((e) => norm(e.text) === norm(ex.text) && Math.abs(new Date(e.ts) - new Date(ex.ts)) < 10 * 60 * 1000)) {
    return null;
  }
  if (!g) {
    g = {
      id: `g${db.nextId++}`,
      rule: ex.rule,
      custom: null,
      status: 'active',
      examples: [],
      sessionIds: [],
      count: 0,
      firstSeen: ex.ts,
      lastSeen: ex.ts,
    };
    db.grudges.push(g);
  }
  g.count++;
  if (!g.sessionIds.includes(ex.session)) g.sessionIds.push(ex.session);
  g.examples.push({ rule: ex.rule, text: ex.text.slice(0, 300), project: ex.project, session: ex.session, ts: ex.ts, source: ex.source });
  if (g.examples.length > MAX_EXAMPLES) g.examples.splice(0, g.examples.length - MAX_EXAMPLES);
  if (ex.ts && (!g.firstSeen || ex.ts < g.firstSeen)) g.firstSeen = ex.ts;
  if (ex.ts && (!g.lastSeen || ex.ts > g.lastSeen)) g.lastSeen = ex.ts;
  return g;
}

function get(db, id) {
  return db.grudges.find((g) => g.id === id);
}

function merge(db, intoId, fromIds) {
  const into = get(db, intoId);
  if (!into) throw new Error(`no grudge ${intoId}`);
  for (const id of fromIds) {
    const g = get(db, id);
    if (!g || g === into) continue;
    into.examples.push(...g.examples);
    into.examples.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (into.examples.length > MAX_EXAMPLES) into.examples.splice(0, into.examples.length - MAX_EXAMPLES);
    for (const s of g.sessionIds) if (!into.sessionIds.includes(s)) into.sessionIds.push(s);
    into.count += g.count;
    if (g.firstSeen && g.firstSeen < into.firstSeen) into.firstSeen = g.firstSeen;
    if (g.lastSeen && g.lastSeen > into.lastSeen) into.lastSeen = g.lastSeen;
    g.status = 'merged';
    g.mergedInto = into.id;
  }
  return into;
}

// Grudges worth injecting: said in 2+ sessions, still active, and either
// global (seen in 2+ projects) or from the current project.
function standing(db, project, limit = 12) {
  // Once a deep scan exists, it supersedes older regex grudges; new live ones still count.
  return db.grudges
    .filter((g) => g.status === 'active' && sessions(g) >= 2)
    .filter((g) => g.deep || !db.deepAt || String(g.firstSeen) > db.deepAt)
    .filter((g) => {
      const p = projects(g);
      return !project || p.length !== 1 || p[0] === project;
    })
    .sort((a, b) => sessions(b) - sessions(a) || String(b.lastSeen).localeCompare(String(a.lastSeen)))
    .slice(0, limit);
}

module.exports = { HOME, FILE, load, save, key, addExample, findMatch, get, merge, sessions, projects, display, standing };
