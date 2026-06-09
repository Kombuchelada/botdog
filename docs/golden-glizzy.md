# Golden Glizzy

A random reward that fades onto the GlizzyClicker screen, stays clickable for
~30 seconds, then fades away. Clicking it rolls **one** reward from a weighted
table. It's the active-play counterpart to the idle economy: idle players get
nothing, players who watch for the spawn get a meaningful boost.

Defined in `glizzy.js` (catalogue + `claimGoldenGlizzy`) and `game.js`
(spawn/animation/claim UI + `POST /api/game/golden`).

## Reward catalogue

Weights are out of **1000**, so the mega is exactly **1 in 1000**. Magnitudes
were tuned against real player data (see "How it was balanced"). The "worth"
column is roughly how many minutes of the player's current production each
reward is worth — the unit that stays meaningful whether you make 25/s or 25M/s.

| Reward | Odds | Effect | ≈ Worth |
|---|---|---|---|
| 🌠 **Golden Rush** (mega) | 1 / 1000 | ×500 production for 10s | ~83 min |
| ⚡ Super Frenzy | 9.0% | ×13 production for 2 min | ~24 min |
| ⚙️ Overdrive | 18.0% | your **best building** ×7 for 3 min | ~14 min |
| 🔥 Frenzy | 28.0% | ×4 production for 3 min | ~9 min |
| 💰 Cash Splash | 20.0% | instant +6 min of current production | ~6 min |
| 🍀 Lucky! | 24.9% | 20% of bank, floored to 2 min / capped to 10 min of production | 2–10 min |

Result: a clean rarity→value curve (83 → 24 → 14 → 9 → 6 → 2–10), no single
common reward dominating expected value (each ~20–30%), and a median **EV of
~9 minutes of production per golden glizzy** ≈ +110% effective production *while
actively catching them*.

## How it was balanced (data-driven)

Pulled live production data (`GET /api/export-database`) and evaluated candidate
magnitudes against every active player. Three facts drove the design:

1. **One building is ~75–80% of production** for real players (Stadium Vendor),
   so "best building ×N" behaves almost like a global multiplier. The original
   Overdrive (×12 / 5 min) was secretly worth ~44 min and ~55% of the feature's
   entire value — trimmed to ×7 / 3 min.
2. **Active players keep tiny banks (1–5 min of production)**; only occasional
   hoarders sit on ~60 min. A pure "% of bank" Lucky was a dud for the people
   actually playing and a jackpot for idlers — so it's floored/capped to a band
   of *production* (2–10 min).
3. **Production spans 25/s → 25M/s.** Every reward therefore scales with
   production, never with flat numbers.

Guiding rules for future tuning:

- Weights must keep summing to 1000 so the mega stays exactly 1/1000.
- Express every magnitude as "minutes of production" and keep the rarity→value
  curve monotonic.
- Keep each common reward's share of expected value under ~⅓ so no single drop
  dominates.

## Server-authoritative design (anti-cheat)

`validateAndClampSave` caps a player's earnings against a budget derived from
their *previous* server state, so a buff applied only on the client would be
clamped right back off. Golden glizzies are therefore rolled and recorded on the
**server**:

- The client spawns the visual on a timer and, on click, calls
  `POST /api/game/golden`. It never decides the reward.
- `claimGoldenGlizzy(userId)` rolls the table, then:
  - **instant rewards** (Lucky, Cash Splash) are credited to `glizzies` +
    `lifetime` directly;
  - **timed buffs** (Frenzy, Super Frenzy, Overdrive, Golden Rush) are written
    into `state.golden_effects` as `{ kind, mult, [building], expires_at }`.
- `computeEffectiveRates` reads active (non-expired) `golden_effects`, so the
  anti-cheat budget automatically allows the buffed earnings. Expired buffs are
  filtered at compute time and pruned on save/load.
- `validateAndClampSave` carries `golden_effects` and `last_golden_at` forward
  from the previous state (they're server-owned — never trusted from the client)
  and prunes expired buffs. **Forgetting this would wipe active buffs on the next
  save**, which fires every 5 s.
- A server-side claim floor (`GOLDEN_CLAIM_FLOOR_MS`, 200 s) stops a script from
  farming the endpoint faster than golden glizzies could legitimately appear.
  Legit spawns are ≥4 min apart, so real players never hit it.

**Buffs don't stack.** `addGoldenBuff` replaces any existing buff in the same
group rather than adding a second (newest wins). All global production
multipliers — Frenzy, Super Frenzy, Golden Rush — share the `prod` group, so two
×4 Frenzies never compound to ×16. A building boost (Overdrive) only conflicts
with another boost on the *same* building and still combines with a global
Frenzy (different effect, not a stack). In production this is mostly belt-and-
suspenders: spawns are ≥4 min apart and timed buffs last ≤3 min, so two timed
buffs can't normally overlap anyway.

## Local testing

Set `GLIZZY_TEST_MODE=1` to spawn golden glizzies every 6–14 s and drop the
claim floor to 3 s, so all reward types are visible in under a minute. **Never
set this in production.** `window.__spawnGolden()` is also exposed in the browser
console to force a spawn on demand.

Seed realistic demo data with:

```bash
DB_PATH=./golden-demo.db node scripts/seed-golden-demo.js
DB_PATH=./golden-demo.db GLIZZY_TEST_MODE=1 \
  ADMIN_PASSWORD=dev PUBLIC_KEY=dummy DISCORD_TOKEN=dummy APP_ID=dummy \
  node app.js
# open http://localhost:3000/game  (dev-bypass logs you in as the seeded owner)
```
