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
4. **Production is 0 until the first building.** So instant grants scale off
   `goldenBaseRate` = `max(perSecond, perClick, 1)`, not `perSecond` alone.
   Scaling off production alone made Cash Splash and Lucky! — 45% of the table
   — pay literally "+0 glizzies" to anyone who hadn't bought a building yet.
   Timed `prod_mult` buffs are fine as-is: `globalMult` multiplies `perClick`
   too, so a Frenzy is a click-power buff for a building-less player.

**No reward may ever be a dud.** Every branch of `claimGoldenGlizzy` grants at
least 1 glizzy or a live buff, and the client always toasts — including on
failure. A golden glizzy that vanishes with no feedback reads as a broken game,
which is exactly how the flat claim floor was experienced.

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
- A server-side claim floor stops a script from farming the endpoint faster than
  golden glizzies could legitimately appear. It is **derived per player** from
  their own spawn cadence (`goldenClaimFloorMs` → `goldenSpawnFor(state)`),
  clamped to 60–200 s with 20 s of grace. It must never be a flat constant: the
  frequency upgrades (Lucky Day + Serendipity) drop the minimum spawn interval
  to 136 s, so the old flat 200 s floor silently rejected ~24% of claims for
  every player who owned them — the exact players who had paid for glizzies to
  appear *more* often. If you add another `golden_frequency` upgrade, this stays
  correct automatically; a hardcoded number would not.

**Same-group buffs eclipse; different groups stack.** All global production
multipliers — Frenzy, Super Frenzy, Golden Rush — share the `prod` group; a
building boost (Overdrive) is its own group per building, so it genuinely
stacks with a global Frenzy (both applied multiplicatively). Within a group,
buffs never compound — two ×4 Frenzies are never ×16 — because at any instant
only the strongest *running* buff applies. And a claim can never downgrade or
void a buff (`addGoldenBuff`):

- A **stronger** claim starts immediately. The weaker buff it eclipses keeps
  ticking on the wall clock and resumes if it outlives the stronger one (catch
  a Golden Rush mid-Frenzy → ×500 for 10 s, then back to your Frenzy).
- A **weaker or equal** claim is queued (`starts_at`) to begin the moment the
  buffs beating it expire, with its full duration intact. The toast says
  "queued behind your stronger buff" and its chip renders dimmed with "next".
  (Equal-mult claims queue too, so a second Frenzy is a duration extension.)

The original "newest wins" replacement assumed timed buffs could never overlap
(spawns ≥4 min apart, buffs ≤3 min) — the frequency + duration upgrades broke
that assumption, and a ×4 Frenzy would flat-out replace a running ×13 Super
Frenzy. `computeEffectiveRates` (server) and `computeRatesFor` (client) both
implement strongest-running-per-group and must stay in lockstep. A per-group
cap of 8 stored effects (drop the farthest-out) keeps `GLIZZY_TEST_MODE`'s
seconds-long claim floor from building silly queues; the prod claim floor makes
the cap unreachable in real play.

**Responses race; the newer `save_seq` wins.** An autosave and a golden claim
can be in flight together (`save()` is re-entrant — a second caller awaits the
same in-flight promise — but the 5 s interval can still overlap a claim). If
the autosave's response landed *after* the claim's, the client used to adopt
the older snapshot and wipe the just-granted buff — buffs looked like they
"didn't stick". `adoptServerState` now drops any response whose `save_seq` is
older than what's already adopted and marks the state dirty so the next tick
resyncs.

## Local testing

Set `GLIZZY_TEST_MODE=1` to spawn golden glizzies every 6–14 s and pin the
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
