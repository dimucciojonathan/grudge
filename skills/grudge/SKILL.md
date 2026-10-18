---
name: grudge
description: Review what the user has had to correct you about across sessions (recorded by the grudge plugin), turn it into well-scoped rules, and update CLAUDE.md. Use when the user runs /grudge, asks what they keep correcting you about, or wants repeated corrections turned into CLAUDE.md rules.
---

# grudge

The grudge plugin records the user's corrections and groups repeats across sessions. The CLI lives at `~/.grudge/grudge.js`. If it's missing, the plugin hasn't run yet; tell the user to start a new session.

## Pick the path

**If the user wants the thorough version** (or there's no deep data yet and they agree to spend roughly $1–3 of model usage), run the pipeline and show each step's output:

```bash
node ~/.grudge/grudge.js scan --deep      # small model reads every follow-up message
node ~/.grudge/grudge.js refine           # scope each preference: when it applies, where it belongs
node ~/.grudge/grudge.js claude-md        # preview the CLAUDE.md edits
```

Show the user the preview and ask before running `node ~/.grudge/grudge.js claude-md --write`. Never write without a yes.

**Otherwise (quick, free):**

1. `node ~/.grudge/grudge.js scan --quiet` then `node ~/.grudge/grudge.js list --json`.
2. Read each grudge's examples. False positives get `forgive <id>`, duplicates get `merge <keep> <other>`. For the real ones, write a rule that names *when* it applies (e.g. "When writing commit messages: no emojis") and save it with `rule <id> "<text>"`.
3. Show a short table, ask which to add, and write them under a `## Learned preferences` section. Global rules go in `~/.claude/CLAUDE.md`, rules from one project go in that project's `CLAUDE.md`.

## Principles

- Scope beats breadth. A rule that fires in the wrong situation is worse than no rule.
- Only write what the user's own words support.
- Don't duplicate what CLAUDE.md already says.
- Keep it light. The plugin is called grudge, but the user should feel heard, not scolded.
