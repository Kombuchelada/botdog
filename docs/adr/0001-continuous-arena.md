# The GlizzyBrawl Arena is continuous — no matches, no wins

GlizzyBrawl needed a session structure, and the obvious one for a platform
fighter is discrete matches (or timed bouts) with winners. We deliberately
rejected that: the Arena is one always-on brawl that never concludes.
Visitors drop in mid-fight, get KO'd, respawn, and leave whenever — the
page is a *place*, not a queue for games, and that drop-in-anytime feel
was judged worth more than crowning winners.

## Considered Options

- **Timed bouts** (~3-minute rounds inside one persistent arena) — was the
  recommended option: it yields a "wins" stat, crowning moments, and natural
  Discord-announcement hooks. Rejected by the owner in favor of the purer
  live-arena fiction.
- **Discrete lobbied matches** — rejected outright; waiting rooms kill the
  drop-in pitch at friend-group traffic levels.

## Consequences

- **"Win" does not exist as a stat.** The ledger records KOs, Falls, best
  KO Streak, arena time, and per-character KOs — nothing else. The
  scoreboard is all-time KOs/Falls (primary) and the Pacific Day Tally
  (secondary). Don't add a win column; it has no meaning here.
- Retrofitting bouts/matches later means a schema migration and a new stat
  category, not a small patch — the persistence model deliberately has no
  match concept to hang one on.
- Nothing ever ending is also the deploy story: a Railway push killing the
  process mid-fight costs no one a match, because there is no match to
  lose. Clients auto-reconnect and respawn.
- Scoreboard integrity is protected by rules instead of round boundaries:
  ~60s AFK despawn, and CPU practice fighters (solo-only) leave no
  persistent stats at all.
