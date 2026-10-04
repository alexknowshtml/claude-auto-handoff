# claude-auto-handoff

A Claude Code mod that hands a long session off to a fresh one before the context fills up. It replaces auto-compact.

At the threshold, Haiku writes a structured handoff brief to disk. Then the mod runs `/clear` and seeds the new session with one line that points at the brief. The fresh session reads the brief and keeps working.

## Why not auto-compact?

Auto-compact summarizes in place, and you can't control what it keeps. A handoff brief has a fixed structure that you can edit. It covers work in progress, decisions, assumptions to verify, dead ends, your last request and whether it was answered, and the next step. The files, commits and issues sections come from the transcript in code, so they don't depend on the model's memory.

## What happens

1. **Threshold.** The mod checks the context size after each turn and before each model request, including tool output that hasn't been measured yet. Once it's past the threshold, the mod refuses new tool calls, so one burst of reads can't overflow the window.
2. **Brief.** Haiku writes the brief from the transcript. If Haiku fails, a facts-only brief stands in. Briefs go to `~/.claude/state/auto-handoff/<session-id>.md`.
3. **Clear and seed.** The mod runs `/clear` and sends the fresh session one line: read the brief and follow its Instructions section.
4. **Toasts.** You see one toast when the threshold trips and one when the new session is measured, such as `↪ handed off · 1a2b3c4d → 5e6f7a8b · 162k → 45k`, followed by the brief's viewer link.
5. **Viewer.** Each brief also gets a readable page in `~/.claude/state/auto-handoff/pages/`. The page shows the brief and every earlier handoff in the same chain, linked in order. By default the mod serves these pages on your Tailscale IP at port 3846, so you can open them from any device on your tailnet. Devices off your tailnet can't reach them. The server starts with the first session that loads the mod and runs while that session is open; if it stops, the next session to finish a turn starts it again. Without Tailscale, the link is the local file.

Loop guards stop a fresh session that starts large from handing off again right away. They also cap how many handoffs run in a row before you type something.

## Install

Requires a Claude Code build with mods (function-hook plugins).

```sh
git clone https://github.com/alexknowshtml/claude-auto-handoff.git ~/claude-auto-handoff
claude --plugin-dir ~/claude-auto-handoff
```

To load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` to the folder in your shell environment, or in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-auto-handoff" } }
```

## Configure

Every setting is a row in `/config` under auto-handoff. They're stored in `~/.claude/settings.json` under `pluginConfigs`.

| Setting | Default | What it does |
|---|---|---|
| `threshold` | `160000` | Context tokens that trigger a handoff. Sized for a 200k window: it leaves room for the brief and the turn in flight |
| `maxConsecutiveHandoffs` | `2` | Handoffs allowed before you type a prompt; past this, the mod pauses until you do |
| `briefTemplate` | `~/.claude/auto-handoff/brief.md` | Your copy of the sections Haiku writes |
| `instructionsTemplate` | `~/.claude/auto-handoff/instructions.md` | Your copy of what the fresh session is told to do |
| `ignoreFiles` | blank | Regex for edited files to leave out of the brief, such as caches or synced state |
| `viewer` | `tailscale:3846` | Where to serve the brief pages, as `host:port`. `tailscale` as the host means this machine's Tailscale IP. Leave blank for no server |

Environment variables:

- `AUTO_HANDOFF_TOKENS=60000` overrides the threshold for one run, so you can watch a handoff without filling 160k first.
- `AUTO_HANDOFF_DISABLE=1` turns the mod off for one session, viewer server included.
- `DISABLE_AUTO_COMPACT` also turns it off. When something else manages the context limit, such as a wrapper that pipes the session, `/clear` would break that pipe. The viewer server still runs there.

## Change the brief's structure and rules

The brief is shaped by two markdown files. The defaults live in this repo's [`templates/`](templates/) folder:

- **[`templates/brief.md`](templates/brief.md)** is the prompt Haiku gets after the transcript. Each `## ` heading is a section of the brief.
- **[`templates/instructions.md`](templates/instructions.md)** goes at the top of the brief and tells the fresh session what to do with it.

On a session's first start, the mod copies both files to `~/.claude/auto-handoff/` if they aren't there yet. Edit those copies, not the ones in the repo, so a `git pull` never overwrites your changes. The next handoff uses your version.

To get the current default back, delete your copy. The next start copies it fresh. To keep your files somewhere else, point `briefTemplate` or `instructionsTemplate` in `/config` at them.

### Editing `brief.md`

Add, remove, rename or reorder `## ` sections. The text under each heading tells Haiku what to put there. A Haiku reply counts as valid if it contains at least one of your headings. Otherwise the mod falls back to a facts-only brief.

Leave out files and commits sections. The mod adds them from the transcript in code.

### Editing `instructions.md`

It has one switch:

```md
{{#priority}}Shown when the last request is not fully answered.{{/priority}}
{{^priority}}Shown when it is.{{/priority}}
```

The switch reads the brief's `## Last Request from the User` section and its `Status:` line. Keep both in `brief.md` if you want it to work.

## Logs

Everything the mod does is logged to `~/.claude/state/auto-handoff/auto-handoff.log`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

The mod hot-reloads when you save while it's loaded with `--plugin-dir`.

## License

MIT
