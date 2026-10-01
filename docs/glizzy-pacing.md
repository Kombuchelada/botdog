# GlizzyClicker pacing: why the upgrade catalog is priced the way it is

The first 99 upgrades were priced on a guess that nobody would ever own all of
them. By 2026-10-01 one player owned 98, about two months after starting. They
run an autoclicker at the anti-cheat ceiling and a script that buys everything
the moment it's affordable. Both are allowed. The second hundred ("Beyond the
Final Frank", `BEYOND_UPGRADES` in `glizzy.js`) are priced off a simulation of
that player instead of a guess.

Re-run it against a fresh backup before touching prices:

```bash
DB_PATH=./hotdog-data.db node scripts/glizzy-pacing.mjs            # top player
DB_PATH=./hotdog-data.db node scripts/glizzy-pacing.mjs --user ID
```

## The growth function

Income has three parts:

```
income = K · P
P      = Σ_b  n_b · rate_b · mult_b · global          (computeEffectiveRates)
K      = golden-glizzy buffs × clicking               (goldenK)
```

**Buildings alone grow logarithmically.** Building *n* costs `base · 1.15ⁿ`
and adds a fixed amount of production. Doubling your income buys only
`log(2)/log(1.15) ≈ 5` more of each building, which is about +5% production
for a player with a hundred of each. So once upgrades run out, `P` grows
roughly like `log t` and lifetime earnings grow almost linearly. The baseline
run shows this: the top player's income rises only 2.7× over five years with
no new upgrades. **The upgrade list is the growth curve.**

**So costs have to outrun multipliers.** Take a ladder where each step costs
ρ× the last and multiplies income by μ. The wait for step *k* scales like
`(ρ/μ)^k`. When ρ ≤ μ the ladder runs away: each purchase pays for the next
one faster than the last. A draft with +20% globals at ×1.12 per step was
emptied in months. The shipped ladder costs ×1.11 per step and hands out about
×2,950 over all hundred (≈ ×1.08 per step on average, ×8 per 25-step round
against ×13 in cost).

**K is measured, not assumed.** The backups give the top player's lifetime
every half hour. While the autoclicker runs (25.8 clicks/s), income holds at
**~49× base production** for weeks. Clicking alone explains only 3.6×
(`1 + 0.10 · 25.8`). The rest is golden glizzies: Frenzy and Overdrive,
stretched ×2.25 by Get Lucky + Four-Leaf Frank, cover nearly every minute.
They also multiply the click income, because a click pays 10% of the buffed
/s. `goldenK` mirrors the reward table and buff rules. It reproduces 49× with
a claim every ~230 s, close to the client's 271 s mean spawn interval.

K is **very** sensitive to claim cadence:

| claim every | 271 s | 230 s | 200 s | 160 s | 116 s (server floor) |
|---|---|---|---|---|---|
| K | 32 | 49 | 66 | 108 | 235 |

That's why no new upgrade touches golden frequency or duration.

## Scenarios

All of them start from the real save:

| scenario | K | bonuses |
|---|---|---|
| `realistic`: what the backups show | ~49 | Centurion |
| `api_bot`: claims goldens at the server floor | ~235 | Centurion |
| `paranoid`: that, plus Glizzy Pope and a streak never broken from today | ~235 | ×6, +2%/day forever |
| `paranoid_x2`: twice that again (anti-cheat slack, model error) | ~470 | same |

Result on 2026-10-01 (counts of the 101 upgrades not yet owned, by New Year's
Day of each year):

```
scenario      2027  2028  2029  2030  2031  2035  2040  2045   all owned
realistic       14    38    57    77    92    94    94    96   not by 2050
api_bot         38    94    94    95    96    96    97    97   not by 2050
paranoid        94    97    98    98    99    99   100   100   2045
paranoid_x2     95    98    98    99    99   100   100   101   2040
```

The bot that exists gets one every couple of weeks through 2030. The worst bot
the rules allow can't finish before 2040. Prices are
`10^(20 + 0.045·i)`, plus a tail of `+0.05·(i−88)²` decades from #88. The
main ladder is tuned to `realistic`. The tail exists because `paranoid` out-earns
`realistic` by ~450× by 2031, so the last dozen have to span more than that.

## Clicking stays worth it

A click pays `(clickPower + perBuilding)·global + 0.10·perSecond`. At the top
of the game, the first term is ~0.002% of a click: the whole ×1.34M click
ladder is decoration there. The second term is a fixed share of production.
Every new upgrade multiplies production, so it scales clicks and idling by the
same factor. The active-to-idle ratio is `1 + 0.10·cps` with or without them.

Golden glizzies are where clicking's edge can erode. Instant grants (Cash
Splash, Lucky!) pay an idler as much as a clicker. A draft that included three
×1.5 golden-payout upgrades moved a 6-clicks/s human from +48% over idling to
+22%. They were cut. Measured with the shipped catalog:

| | no golden | with golden |
|---|---|---|
| idle | 1.0 | 15.9 |
| human, 6 clicks/s | 1.6 | 23.6 (+48%) |
| bot, 25.8 clicks/s | 3.6 | 49 |

`test/glizzy-beyond.test.js` holds all of this: the catalog shape, that every
icon has art, the effect-type allowlist, the click ratio, the calibration
(change the golden table and that test tells you to re-run the pacing), and
both pacing bounds.
