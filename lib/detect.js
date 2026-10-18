'use strict';

// Heuristic correction detector. No LLM, no network: this runs inside a
// UserPromptSubmit hook, so it has to be instant and free. The /grudge skill
// lets Claude clean up whatever this lets through.

const STRONG_START =
  /^\s*(no+|nope|nah|wrong|stop|wait|undo|revert|ugh|don'?t|dont|do not|never|not like that|that'?s not|thats not|not what|why (did|would) (you|it)|i (said|told you|asked)|you (forgot|missed|broke|ignored))\b/i;

const SIGNALS = [
  [/\bi (already |just )?(said|told you|asked( you)?|mentioned)\b/i, 2],
  [/\byou (keep|always|again|still|forgot|ignored|broke)\b/i, 2],
  [/\b(again|for the (second|third|fourth|\w+th) time|how many times)\b/i, 1],
  [/\bstop (doing|using|adding|writing|making|creating|running|changing|touching|asking|it|that|this)\b/i, 2],
  [/\b(don'?t|do not|never|please don'?t|dont)\s+(\w+\s+){0,2}?(use|add|do|create|write|make|run|touch|change|modify|delete|remove|mock|commit|push|install|edit|rename|format|import|include|put|call|ask|wrap|guess|assume|skip|leave|start|bother|output|print|reply|respond|summari[sz]e)\b/i, 2],
  [/\binstead\b/i, 1],
  [/^\s*use\s+\S+(\s+\S+)?,?\s+not\s+\S/i, 2], // "use pnpm, not npm"
  [/^\s*no\s+\w+/i, 1], // "no emojis in commit messages"
  [/\bnot what i (asked|wanted|meant|said)\b/i, 2],
  [/\b(that'?s|this is|it'?s|thats|its) (wrong|not right|incorrect|broken|not it|not correct|worse)\b/i, 2],
  [/\bi didn'?t (ask|want|say)\b/i, 2],
  [/\bwhy (did|would) you\b/i, 2],
  [/\b(revert|undo|roll back) (that|this|it|the|your)\b/i, 1],
  [/\bshould(n'?t| not) (have|be|do)\b/i, 1],
  [/\b(wtf|come on|seriously|ffs)\b/i, 1],
  // Style steering: no "no" anywhere, but it's the most durable kind of grudge.
  [/\b(more|less|too|overly) (concise|verbose|wordy|long|short|detailed|formal|casual|technical|complicated|complex|fragmented)\b/i, 2],
  [/\binstead of (all )?(the |these |those )?(bullets?|bullet points?|lists?|headers?|headings?|tables?|emojis?|comments?)\b/i, 2],
  [/\b(keep it|make it|be) (short|shorter|simple|simpler|brief|briefer|tight|tighter)\b/i, 2],
  [/\bi (like|liked|prefer|preferred) the (previous|last|original|old|first|other) (one|version)?/i, 2],
  [/\b(previous|last|original|old|first) (one|version) (was|is) better\b/i, 2],
  [/\btoo (much|many) (detail|text|words|bullets|comments|code|explanation)/i, 2],
];

// After an interrupt or a rejected tool call these just mean "carry on".
const TRIVIAL = /^\s*(continue|go on|go ahead|keep going|resume|proceed|ok(ay)?|yes|yep|y|sure|try again|retry|sorry,? continue)\s*[.!]*\s*$/i;

const DIRECTIVE =
  /\b(don'?t|dont|do not|never|always|stop|instead|use|should|must|only|avoid|prefer|keep|more|less|shorter|simpler|concise)\b/i;

// Only strip interjections followed by punctuation: "no, use X" → "Use X",
// but "no emojis" and "stop adding comments" keep their meaning.
const LEAD_FILLER =
  /^\s*((no+|nope|nah|wait|ugh|hmm+|ok(ay)?|stop|wrong|again|sorry|actually|seriously|come on)\s*[,.!:;—-]+\s*)+/i;

function stripNoise(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ') // pasted code
    .replace(/`[^`\n]{40,}`/g, ' ') // long inline code
    .replace(/https?:\/\/\S+/g, ' ')
    .trim();
}

// `redirect`: the user just interrupted Claude or rejected a tool call, so
// whatever they type next is steering, even if it's phrased politely.
function score(text, { redirect = false } = {}) {
  const t = stripNoise(text);
  if (!t || t.length > 1200) return 0;
  if (redirect && TRIVIAL.test(t)) return 0;
  let s = STRONG_START.test(t) ? 2 : 0;
  if (redirect) s += 2;
  for (const [re, w] of SIGNALS) if (re.test(t)) s += w;
  return s;
}

// Assume the prompt follows an assistant turn; a first prompt is a request,
// not a correction.
function isCorrection(text, opts) {
  return score(text, opts) >= 2;
}

function sentences(t) {
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pull out the part of the message that reads like a standing rule.
function extractRule(text) {
  const t = stripNoise(text);
  const parts = sentences(t);
  let best = null;
  let bestScore = -1;
  for (const p of parts) {
    let s = 0;
    if (DIRECTIVE.test(p)) s += 2;
    for (const [re, w] of SIGNALS) if (re.test(p)) s += w;
    if (/^\s*why\b/i.test(p) && !DIRECTIVE.test(p)) s -= 1; // pure frustration
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  let rule = (best || t).replace(LEAD_FILLER, '').trim();
  if (rule.length < 12) rule = t.replace(LEAD_FILLER, '').trim();
  if (rule.length > 180) rule = rule.slice(0, 177).replace(/\s+\S*$/, '') + '…';
  return rule ? rule[0].toUpperCase() + rule.slice(1) : rule;
}

const STOP = new Set(
  (
    'the a an and or but to of in on for with at by from is are was were be been it its this that these those ' +
    'i you me my your we our us he she they them do does did doing done dont don not no never stop please again ' +
    'instead said told say asked ask just like want wanted need needs make made thing things way here there ' +
    'what why how when where which who should would could can will can\'t cant use using used keep always ' +
    'also only then than so very really actually still already now ok okay yes yeah hey sorry thanks thank ' +
    'code file files work working one some any all more less get got have has had going go let lets it\'s ' +
    'that\'s thats im i\'m youre you\'re ive time times wrong right'
  ).split(/\s+/)
);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Same complaint, no shared words: "more concise" and "way too long" are one
// grudge. Each concept becomes a token that, when shared, is a match.
const CONCEPTS = [
  ['@length', /\b(concise|verbose|wordy|terse|succinct|brief(er)?|shorter|too long|long[- ]winded|tl;?dr|rambl\w*)\b/i],
  // Only when it's about the shape of the reply, not a mention of "the bullet point".
  ['@format', /\b((fewer|less|no|too many|all the|instead of( all)?( the)?) (bullets?|bullet points?|headers?|headings?|markdown|lists?)|(more |few |in )?(paragraphs|prose)|fragmented)\b/i],
  ['@ask-first', /\b(without asking|ask (me )?(first|before)|check with me|propose (the )?changes|change anything yet|confirm (with me )?first)\b/i],
  ['@push', /\b(git push|push(ing)? (anywhere|to|it|the|this|without)|don'?t push)\b/i],
  ['@comments', /\bcomments?\b/i],
  ['@emoji', /\bemojis?\b/i],
  ['@mocks', /\bmock(s|ing|ed)?\b/i],
];

function concepts(text) {
  return CONCEPTS.filter(([, re]) => re.test(text)).map(([c]) => c);
}

function tokens(text) {
  const out = new Set(concepts(String(text || '')));
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
    const w = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  let inter = 0;
  for (const x of a) {
    if (!B.has(x)) continue;
    if (x[0] === '@') return 1;
    inter++;
  }
  const min = Math.min(a.length, b.length);
  if (min === 1) return inter === 1 && Math.max(a.length, b.length) <= 2 ? 1 : 0;
  return inter >= 2 ? inter / min : 0;
}

module.exports = { score, isCorrection, extractRule, tokens, similarity, stripNoise };
