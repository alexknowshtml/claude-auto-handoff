# claude-auto-handoff

A Claude Code mod that hands a long session off to a fresh one before the context fills up. It replaces auto-compact.

20k before the threshold, the model is asked to finish its step and call the `handoff` tool with a structured brief as its argument; past the threshold, a fork of the model writes it instead (Haiku if that fails). The brief goes to disk. Then the mod runs `/clear` and seeds the new session with one line that points at the brief. The fresh session reads the brief and keeps working.

This fork (branch `context-manager`, from upstream `079b2a0`) adds:

- **The brief from the working model, at no extra request.** Past a soft line 20k below the threshold, the next tool result tells the model to finish its step and call `handoff` with the brief as its argument. The brief is written inside a request the session was making anyway, by the model that did the work, at a boundary it picks; the mod then ends the turn without the sign-off request. If the model never calls it, a fork of the model writes the brief at the threshold over its cached transcript (one extra request); Haiku is the last resort.
- **A measured threshold.** 150k, from 13,574 requests across 272 sessions: lowest token cost plus wall time at 140k, and the soft line lands handoffs between 130k and 150k. 300k cost about 35% more per unit of work. `scripts/threshold/` re-runs the analysis on your own transcripts.
- **The previous brief and tool output reach Haiku.** Each brief is written from the brief the session started from, read from disk, plus every tool call with what it returned. A chain of handoffs no longer loses what the earlier briefs held.
- **Project history, at a fixed budget.** Each handoff appends a short digest to its project's log. Pairs of entries compress into summaries, pairs of those into one, and so on (the idea from [OptMem](https://github.com/VictorTaelin/OptMem)). Every brief ends with a `## Project History` section of at most 24 lines, recent sessions whole and older ones merged. Haiku does the compressing in the background, so no session waits for it.
- **Handing off on request.** `/handoff` hands off now; `/handoff 60k` sets this session's threshold. The model can call the `handoff` tool at the end of a phase of work.
- **Defaults:** the threshold is 150k, never closer than 40k to the context window; the viewer server is off; the brief no longer tells the next session to start a subagent.

![auto-handoff in a live session: the tool gate stops a read at the threshold, the panel walks through the brief and /clear, and the fresh session picks the work back up](docs/demo.gif)

A live run on Haiku with the threshold at 80k. The mod refuses a read at the threshold, writes the brief, clears, and the fresh session is back at work about 7 seconds later at 31k. ([video](docs/demo.mp4))

## Why not auto-compact?

Auto-compact summarizes in place, and you can't control what it keeps. A handoff brief has a fixed structure that you can edit. It covers work in progress, decisions, assumptions to verify, dead ends, your last request and whether it was answered, and the next step. The files, commits and issues sections come from the transcript in code, so they don't depend on the model's memory.

## What happens

1. **Threshold.** The mod checks the context size after each turn and before each model request, including tool output that hasn't been measured yet. Once it's past the threshold, the mod refuses new tool calls, so one burst of reads can't overflow the window. Unmeasured tool output is an estimate that can run high, so the real size sometimes comes in under the threshold. A refused call still ends in a handoff, at the next request or the end of the turn.
2. **Brief.** The model's own, passed to the `handoff` tool after the soft-line note. Without one, a fork of the session's own model writes it over its cached transcript; if the fork fails, Haiku writes it from the last 120 messages; if Haiku fails, a facts-only brief stands in. Briefs go to `~/.claude/state/auto-handoff/<session-id>.md`.
3. **Clear and seed.** The mod runs `/clear` and sends the fresh session one line: read the brief and follow its Instructions section. In the transcript, that line's brief path and viewer URL are drawn as links. Claude Code makes them clickable only when it detects a terminal that supports links. Over plain SSH it usually doesn't, so set `FORCE_HYPERLINK=1` if your terminal handles links, or use the status line link below.
4. **A panel above the prompt.** It shows each step with a braille spinner on the one still running: writing the brief, clearing, starting the fresh session. Once the new session is measured it reads `✓ handed off · 162k → 45k` with an `open brief` link, then collapses after 10 seconds. Failures, the loop-guard pause, a facts-only brief and a too-tight threshold stay up until you press Dismiss. Typing `/clear` yourself closes the panel, including one waiting for Dismiss, unless a handoff is running. The panel steps aside while a survey holds that band. The band is drawn on the terminal and desktop only, so on the mobile app or in VS Code the threshold, the result, and anything that stays up also arrive as a toast.
5. **Viewer.** Each brief also gets a readable page in `~/.claude/state/auto-handoff/pages/`. The page shows the brief and every handoff in the same run, linked in order. The served link is short, like `http://100.x.y.z:3846/1a2b3c4d`, so it fits on one line on a phone. With `viewer` set to `tailscale:3846`, the mod serves these pages on your Tailscale IP at port 3846, so you can open them from any device on your tailnet. It is blank by default: no server, and the link is the local file. Devices off your tailnet can't reach them. The server starts with the first session that loads the mod and runs while that session is open; if it stops, including when the mod reloads, the next session to finish a turn starts it again. A session that finds the port already taken logs one line and leaves the running server alone, since it serves the same pages. Without Tailscale, the mod serves on `127.0.0.1` instead, so the link opens only on this machine. If Tailscale comes up later, a session already serving on localhost keeps using it; the next new session can serve on the Tailscale IP.
6. **Status line link (optional).** `statusline/handoff-link.sh` wraps your status line command and adds a `↪ <link>` line when the session came from a handoff. Set it as the `statusLine` command in `~/.claude/settings.json`, with your existing command after it:

   ```json
   "statusLine": { "type": "command", "command": "~/claude-auto-handoff/statusline/handoff-link.sh ~/.claude/my-statusline.sh" }
   ```

   It needs `jq`. It finds the link in the previous brief's header, which names this session in `to:` and the page in `viewer:`.

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
| `threshold` | `150000` | Context tokens that trigger a handoff; the soft line sits 20k below it. Never closer than 40k to the context window, so a 300k setting becomes 160k on a 200k window. A seeded session hands off no sooner than 40k past its own starting size, whatever this says; set it lower than that and the panel tells you where the line actually is |
| `maxConsecutiveHandoffs` | `2` | Handoffs allowed before you type a prompt; past this, the mod pauses until you do |
| `briefTemplate` | `~/.claude/auto-handoff/brief.md` | Your copy of the sections Haiku writes |
| `instructionsTemplate` | `~/.claude/auto-handoff/instructions.md` | Your copy of what the fresh session is told to do |
| `ignoreFiles` | blank | Regex for edited files to leave out of the brief, such as caches or synced state |
| `viewer` | blank | Where to serve the brief pages, as `host:port`, such as `tailscale:3846`. `tailscale` as the host means this machine's Tailscale IP, or `127.0.0.1` when Tailscale isn't set up. Blank: no server; the link is the local file |
| `historyLines` | `24` | Lines of project history each brief carries, at most about 150 tokens each |
| `briefWriter` | `fork` | Who writes the brief when the model did not pass one to `handoff`. `fork`: the session's own model over its cached transcript (one extra request: cache reads plus its output). `haiku`: Haiku from the last 120 messages (cheaper, less complete) |

Environment variables:

- `AUTO_HANDOFF_TOKENS=60000` overrides the threshold for one run, so you can watch a handoff without filling the threshold first. In an open session, `/handoff 60k` does the same for that session alone. It stays set in that shell after the test. Seeded sessions start near 45k, so a value under about 85k leaves them less than 40k of room: the mod then hands off at start + 40k instead and the panel shows `threshold 60k (AUTO_HANDOFF_TOKENS) leaves 15k ...` so you know the override is still live.
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

## Project history

Each project's history lives in `~/.claude/state/auto-handoff/history/<repository root, as a folder name>/`. All worktrees of one repository share it.

- `log.jsonl`: one entry per handoff, append-only: when, which session, its transcript, and a digest of at most 600 characters.
- `tree.json`: the summaries, keyed by entry range (`0-1`, `0-3`, ...). It's a cache: delete it and the next handoff or session start rebuilds it from the log.

A summary that fails stays missing, and the brief shows its two halves instead, so the history is never blocked on Haiku.

## Logs

Everything the mod does is logged to `~/.claude/state/auto-handoff/auto-handoff.log`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

The mod hot-reloads when you save while it's loaded with `--plugin-dir`.

## Changelog

- **0.10.0** (fork) The model writes the brief as the `handoff` tool's argument, asked by a note on the first tool result past a soft line 20k below the threshold; the turn then ends with no further request. Without that brief, `$.model.fork` writes one over the cached transcript, then Haiku. Default threshold 150k, measured (`scripts/threshold/`).
- **0.9.0** (fork) Haiku's prompt carries the previous brief, read from disk, and each tool call's output. Project history: a log of handoff digests, compressed into a fixed-budget `## Project History` section at the end of each brief. `/handoff`, `/handoff <threshold>` and a `handoff` tool. The threshold defaults to 300k, capped 40k below the window. The viewer is off by default. The brief no longer asks for a verifying subagent.
- **0.8.4** Any token figure in Haiku's brief that isn't in Handoff Numbers is marked `[unverified: not in Handoff Numbers]` and logged. The figure is marked, not removed.
- **0.8.3** The brief gets the real numbers: tokens at handoff, the threshold and where it came from, the session's starting size, and how many handoffs ran with no message from you. Haiku must copy them or write "unknown", so a brief can no longer invent a figure like "burned its 200k budget".
- **0.8.2** A refused tool call always ends in a handoff, even when the real size measures under the threshold. Your own `/clear` closes the panel. A second session that finds the viewer port taken exits quietly instead of logging a stack trace.
- **0.8.1** On the mobile app and in VS Code, which don't draw the panel, the threshold, the result and anything that stays up also arrive as toasts.
- **0.8.0** A panel above the prompt replaces the toasts, with a spinner on each step and an `open brief` link.
- **0.7.0** A seeded session hands off no sooner than 40k past its starting size. When the threshold is set tighter than that, the panel says so and names the setting. The viewer serves on `127.0.0.1` when Tailscale isn't available.
- **0.6.0** A viewer page for each brief, served on your Tailscale IP with short links. The pages in a chain link to each other. The seed row's links are clickable, and the status line script adds a handoff link.
- **0.5.0** First release: a Haiku brief, `/clear` and a seed prompt. It includes the tool gate, the check before each request, auto-compact replaced by a handoff, and the loop guards.

## License

MIT
