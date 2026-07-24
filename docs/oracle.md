# The Oracle

A hidden advisor in GlizzyClicker that names the mathematically optimal next
purchase. Unlocked by a cheat code, off by default, purely advisory — it reads
state and ranks purchases, it never grants anything, so it has no anti-cheat
surface at all.

Lives entirely in `game.js`'s client script (`GAME_CLIENT_JS`). No server
changes: `window.GAME` already ships the full `BUILDINGS` / `UPGRADES`
catalogue, the player's state, and their active bonuses.

## Unlocking

**↑ ↑ ↓ ↓ ← → ← → B A** on `/game`. On success: a toast, the 🔮 Oracle button
appears in the sticky bar next to 🏆, and the panel opens. After that, **`O`**
toggles it.

Two localStorage keys, so both survive a reload:

| Key | Meaning |
|---|---|
| `glizzy_oracle` | `'1'` once unlocked. Absent = the button stays hidden. |
| `glizzy_oracle_on` | `'1'`/`'0'` — whether the panel is currently showing. |

The keydown matcher tolerates a restart mid-sequence: on a mismatch it resets to
index 0, or to 1 if the key that failed is itself an `ArrowUp` (so `↑↑↑↓↓…`
still works). It ignores keys typed into an `INPUT`/`TEXTAREA`.

## The ranking

Every candidate is priced the *same* way — there is no per-effect-type valuation
logic:

```
clone the state → apply the purchase → re-run computeRatesFor → Δ perSecond
payback seconds = cost ÷ Δ perSecond      (ascending; lowest wins)
```

This is why the ranker is correct for effects whose value depends on the rest of
the state — `building_synergy`, `global_per_building` — without knowing they
exist. Adding a new effect type to `computeRatesFor` automatically teaches the
Oracle to price it.

Candidates with `Δ ≤ 0` are dropped, so a purchase that adds no production never
appears.

### What's deliberately excluded

| Excluded | Why |
|---|---|
| `click_mult`, `click_per_building` | Worth whatever your clicking makes them worth. A ranking that's about idle production can't price them. |
| `golden_frequency`, `golden_duration`, `golden_payout` | Same — value depends on how reliably you catch golden glizzies. |
| Active golden buffs | Stripped from the simulated state (`golden_effects: []`) on *both* the baseline and the candidate. Otherwise a Frenzy would churn the recommendation for its whole duration and revert when it expired. |

Global multipliers (`global_mult`) *are* included even though they also boost
click power — they're ranked on their production contribution alone.

### Buy quantity

Buildings are priced at the player's current ×1/×10/×100 setting, so the badge
always means "tapping this card right now is the best move". Changing the
quantity re-ranks. It genuinely changes the answer: geometric cost scaling
means a ×100 building buy is often beaten by a flat-priced upgrade that a ×1
buy would beat.

### A result that looks wrong but isn't

For players who own **Vertical Integration** (+0.1% production per building
owned), the cheapest building in the game frequently ranks #1 — verified against
live saves:

```
PLAYER …5190 (lifetime 1.98e18) · base 5.184e11/s
  🏗 Mustard Stand   cost 1.25e8   +2.41e8/s   payback 1s
```

A Mustard Stand produces 0.1/s. It ranks first because *any* building adds 0.1%
of total production, and 0.1% of 5.18e11/s dwarfs anything the building itself
makes. The advice is correct: buy the cheapest body available. This is exactly
the kind of answer a hand-written heuristic ("rank by base_rate ÷ cost") would
get wrong, and simulate-and-diff gets right for free.

## UI

- **Panel** (`#oracle-card`, top of the right column) — top 3, each showing
  cost, Δ/s, payback, and either "affordable now" or "ready in X". Rows are
  buttons; tapping one buys it.
- **Ring** — the #1 candidate's card in the buildings/upgrades list gets
  `.oracle-best`: a violet border plus a `🔮 BEST` pseudo-element badge. Violet
  because it has to read against both the orange "affordable" border and the
  emerald "owned" one, and against the plasma palette constraint.

Both lists follow the existing patch-in-place rule (see CLAUDE.md) — the panel
rebuilds only when the ranked ids *or their prices* change, and patches the
"ready in" countdown in place otherwise. Rebuilding three tap targets every
second would eat taps on mobile exactly the way the buildings list used to.

## Cost

~72 candidates × one `computeRatesFor` pass each (≈12 buildings + ≈70 owned
upgrades of inner loop), recomputed once per second only while the panel is
open. A few thousand operations — immeasurable next to the 100 ms production
tick.
