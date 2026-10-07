# Roadmap

Ranked by value for the cost. Nothing here is built yet.

| # | Change | Gains | Cost / risk |
|---|---|---|---|
| 1 | **Rolling checkpoints.** Every few turns, or on each commit, append a Haiku digest of only the new stretch of work to the project log, in the background. | A session that ends without a handoff (closed, crashed) still leaves history: no end-of-session routine. The brief is mostly written before the threshold, so the handoff is near instant. | Haiku tokens on each new stretch only. |
| 2 | **Inject the brief.** Put the brief in a hidden message (`$.session.append`) instead of asking the fresh session to Read it. | One model round trip fewer per handoff, and no line-number overhead from Read. | Small. |
| 3 | **Idle handoff while the cache is warm.** After about 55 minutes idle with a large context (the cache TTL is 1h), hand off before the cache expires. | Coming back after a break costs a ~45k fresh session, not a re-read of ~300k uncached tokens. | Hands off a session nobody is watching; respect the loop guard. |
| 4 | **History for every new session.** Optionally carry the project's history section into any new session in that repository, not only seeded ones. Promote durable facts from compressed entries into `memory-index`. | Every session starts knowing the project's arc: the portal behaviour. | About 3.6k tokens per new session; opt-in. |
| 5 | **Git state from code.** Run `git status --short`, `git log -5 --oneline` and the branch at handoff and put them in the facts. | Removes a class of wrong claims from the Git / System State section. | Small. |
| 6 | **Search, don't carry.** `/history recall <regex>` and `zoom <a-b>` over the log, and search over the session transcripts. | The fresh session pulls detail on demand instead of carrying it. | Small. |
| 7 | **Measure.** Per handoff: tokens before and after, brief size, seconds until work resumes, Haiku tokens. A `/handoff stats` line. | Tune the threshold and history budget from data. | Small. |

Known upstream mismatch: the README says `AUTO_HANDOFF_DISABLE` stops the viewer server, but `keepServing` ignores it. Moot while the viewer is off.
