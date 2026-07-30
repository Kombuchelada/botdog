# Year of the Glizzy

A Discord bot, public dashboard, and games tracking hot dog consumption
in a friend group during 2026. One shared language covers the counter, the
website, GlizzyClicker, and GlizzyBrawl.

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

### GlizzyBrawl

**GlizzyBrawl**:
The realtime platform-fighter game. Everyone who joins fights in the one
shared Arena.
_Avoid_: the fighting game, Smash clone

**Arena**:
The single always-on brawl all GlizzyBrawl players share. There is exactly
one, it never concludes, and joining it is immediate — no queue, no lobby.
_Avoid_: match, lobby, session, room, win (nothing ever ends, so nothing is won)

**Fighter**:
One of the four playable characters: The Glizzy, Ketchup, The Grill,
Corn Dog. A player fights as exactly one Fighter at a time.
_Avoid_: hero, champion, skin

**Percent**:
A fighter's accumulated damage. It has no ceiling and never kills by
itself — higher Percent only means being launched farther when hit.
_Avoid_: HP, health, damage bar

**KO**:
Knocking another player past the Arena's blast zone. The unit the all-time
scoreboard is denominated in.
_Avoid_: kill, frag, elimination

**Fall**:
Being KO'd. The counterpart stat to the KO; a player's record is KOs
against Falls.
_Avoid_: death, loss

**KO Streak**:
Consecutive KOs without a Fall. Best-ever streak is remembered per player.
_Avoid_: killstreak

**Day Tally**:
A player's KOs and Falls for the current Pacific day — the secondary
scoreboard beside the all-time board.
_Avoid_: daily score, session score

**CPU**:
A server-controlled practice fighter, spawnable only while a lone player
is in the Arena. Fights involving CPUs leave no persistent stats, and all
CPUs vanish when a second human joins.
_Avoid_: bot (ambiguous with the Discord bot), AI, NPC
