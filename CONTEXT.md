# Year of the Glizzy

A Discord bot, public dashboard, and games tracking hot dog consumption
in a friend group during 2026. One shared language covers the counter, the
website, and GlizzyClicker.

## Language

**Glizzy**:
A hot dog: one frank in one bun, eaten by a participant. The unit everything
else is denominated in.
_Avoid_: frank (that's the sausage alone), wiener, dog (ambiguous with the bot)

**Protest**:
A negative-amount `hotdog_events` row. Subtracts from totals and never
sustains a streak or counts toward an eating day.
_Avoid_: correction (admin edits are corrections; protests are intentional)

**Net Total**:
Glizzies eaten minus protests, for a user or the whole server. The canonical
"how many hot dogs" number.
_Avoid_: gross total, count

**Pace**:
The server-wide net consumption rate over the trailing 28 days, in glizzies
per day. The canonical "how fast are we eating" number.
_Avoid_: velocity, rate (unqualified)

**Average Glizzy**:
The canonical hot dog all By-the-Numbers stats scale from: one 57 g (2 oz,
"bun-length") beef frank plus one 43 g white bun, 6 in / 15.2 cm long.
Nutrition and cost always include the bun. Sourced from USDA FoodData
Central; length from NHDSC.
_Avoid_: standard hot dog, typical dog

**Projected Year-End Total**:
Net Total plus Pace times days remaining in 2026. Displayed with a range:
low bound from trailing-14-day pace, high bound from year-to-date average
pace.
_Avoid_: forecast, estimate (unqualified)

**Milestone Ladder**:
An ordered list of real-world comparison objects for one stat, spanning
roughly 1,000 to 15,000 glizzies' worth. A stat shows the last milestone
conquered and progress toward the next; comparisons upgrade themselves as
consumption grows.
_Avoid_: benchmark list, scale

**Chestnut**:
A unit of consumption: 76 glizzies, Joey Chestnut's 2021 Nathan's contest
record (76 dogs in 10 minutes).
_Avoid_: contest unit

### GlizzyClicker

**Golden Glizzy**:
A reward that fades onto the GlizzyClicker screen, stays clickable for a
short while, then fades away. Clicking it rolls exactly one reward from a
weighted table. The reward is decided by the server on the claim, never by
the client and never before the click.
_Avoid_: golden cookie, powerup, bonus (a Bonus is something else here)

**Mega**:
A Golden Glizzy reward at weight 10 — one in a hundred. Rare enough to be
worth telling the channel about, common enough that a regular player will
see one.
_Avoid_: jackpot, legendary

**Buff Group**:
The axis a timed Golden Glizzy buff competes on. Within a group buffs never
compound — at any instant only the strongest running one applies, and a
weaker claim waits its turn rather than being lost. Across groups they
stack. The groups are production, click, and one per building.
_Avoid_: category, slot, stack

**Click Power**:
What a single click yields, after click upgrades, click buffs and global
multipliers. Distinct from production, which accrues on its own — a reward
that raises Click Power pays nothing to a player who does not click.
_Avoid_: click value, tap damage, CPC
