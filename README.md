<h1 align="center">grudge</h1>

<p align="center"><b>It remembers every time you told your AI "no."</b></p>

---

You told Claude not to mock the database. On Tuesday. And last Thursday. And in March.

Claude doesn't remember. **grudge does.**

It reads your Claude Code (and Codex) history, finds the corrections you keep repeating, and quietly makes sure every new session starts knowing them. You never have to say it twice. Well, a third time.

```bash
npx grudge-cc
```

```
  You corrected your agent 14 times (50% of your follow-up messages).
  5 of those were things you'd already said in another session:

  1. ×3 Don't mock the database in the tests, use the test container
  2. ×2 Never edit an existing migration, add a new one
  3. ×2 Use pnpm, not npm
  4. ×2 Stop adding comments to every line
  5. ×2 No emojis in commit messages please
```

<sub>Demo data. Run it on yours. It's more embarrassing.</sub>

## Install the plugin (so Claude remembers too)

```
/plugin marketplace add dimucciojonathan/grudge
/plugin install grudge@grudge
```

Send them as two separate messages. That was it.

## What it does

**Before:** session 14, Claude mocks the database again. You type "no, don't mock the database" for the fourth time and quietly lose faith in technology.

**After:** session 14 starts with this already in Claude's context:

```
[grudge] The user has had to correct you about these things in more than one past session.
Treat them as standing rules. Don't make them say it again:
- Don't mock the database in the tests, use the test container (corrected in 3 sessions)
```

How it works:

- **Every prompt.** A tiny local hook notices when you're correcting Claude ("no", "I told you", "stop doing X", "don't…") and files it. No LLM call, no network, a few milliseconds.
- **Grouped across sessions.** "don't mock the db" and "stop mocking the database" are the same grudge. Things you said in *two or more separate sessions* become standing rules.
- **Every new session.** Standing rules get injected at start, scoped to the project they came from, or everywhere if you've said it in multiple projects.
- **The moment you repeat yourself.** If you correct something you've corrected before, Claude is told "this is the third time." It tends to behave after that.
- **`/grudge`.** Claude reviews the raw list, throws out false positives, merges duplicates, rewrites each one as a crisp rule, and offers to write them into `CLAUDE.md`.

## `--deep`: the corrections you didn't know you were making

Most corrections aren't "no, don't." They're "can we simplify this?", "just give me the command", "the previous one was better", or hitting Esc and asking for something else. Regexes can't see those.

```bash
grudge scan --deep
```

A small model (Haiku, through your own `claude` login, so no API key needed) reads every follow-up message you've sent next to what the agent had just said and done. It picks out durable preferences, however politely you phrased them, then groups the same preference said different ways. A few months of history costs a couple of dollars. Runs are headless, with no tools and no session files written.

Then two more steps turn those findings into rules that don't overreach:

```bash
grudge refine            # put each preference back in context
grudge claude-md         # preview the CLAUDE.md edits
grudge claude-md --write # apply them (with a backup)
```

**`refine`** re-reads the original moments and asks *when* each preference actually applies. "Avoid AI-sounding prose" becomes *"When drafting outreach messages or resume bullets: no slick one-liners about the company."* It doesn't touch your commit messages. Rules get split, narrowed, scoped to one project, or dropped if the evidence doesn't hold up. Anything your CLAUDE.md already says is skipped.

**`claude-md`** writes the survivors into the right file, `~/.claude/CLAUDE.md` for global rules and the project's own `CLAUDE.md` for project rules, inside a `<!-- grudge -->` block it fully owns. Rerunning only ever replaces that block.

## Commands

| | |
|---|---|
| `grudge scan` | read your history, find repeated corrections (this is also what `npx grudge-cc` runs) |
| `grudge list` | what you keep having to say (`--all`, `--json`) |
| `grudge show <id>` | the receipts |
| `grudge forgive <id>` | not a real grudge. It'll never come up again |
| `grudge merge <id> <id>` | same complaint, different words |
| `grudge rule <id> "…"` | rewrite it as a clean rule |
| `grudge export` | CLAUDE.md snippet of your standing corrections |
| `grudge stats` | your correction rate by week, before vs. after installing |

## Does it actually work?

Measure it on yourself. That's the only benchmark that matters for a tool like this:

```bash
grudge stats
```

```
  correction rate before grudge: 6.8%   since installing: 2.9%
```

<sub>Illustrative. Your numbers will be your own.</sub>

It counts how often your follow-up messages are corrections, week by week, and splits the numbers at the day you installed. If grudge isn't lowering that number for you, uninstall it and open an issue telling me why.

## Privacy

By default everything stays on your machine. grudge reads `~/.claude/projects` and `~/.codex/sessions`, writes to `~/.grudge/`, and never makes a network request. The one exception is `--deep`, which sends your follow-up messages (plus a snippet of what the agent did) to Claude through your `claude` CLI, the same place they came from. Zero dependencies, so you can read the whole thing in ten minutes.

Tip: Claude Code deletes transcripts after 30 days by default. Add `"cleanupPeriodDays": 3650` to `~/.claude/settings.json` so grudge has more history to learn from.

## FAQ

**Will it flag things that aren't corrections?**
Sometimes. The live detector is deliberately cheap (regexes, not an LLM) so it can run on every prompt for free. Only things you've said in two or more sessions get injected, and `/grudge` or `grudge forgive` cleans up the rest.

**Isn't this just CLAUDE.md?**
CLAUDE.md is where the rules should end up. grudge is how they get there, because nobody updates CLAUDE.md in the middle of being annoyed.

**Why "grudge"?**
Because it never forgets, and neither should your agent.

## License

MIT
