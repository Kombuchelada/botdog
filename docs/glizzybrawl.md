# GlizzyBrawl

A Smash-style platform fighter at `/brawl`, sharing one always-on **Arena**.
Anyone can watch; a Discord login and a Fighter pick drops you straight into
the fight. Hits build **Percent**, knockback scales with Percent, and crossing
the blast zone is a **KO** — the unit the all-time scoreboard is denominated
in. Nothing ever ends: see [ADR 0001](adr/0001-continuous-arena.md).

Vocabulary (Arena, Fighter, Percent, KO, Fall, KO Streak, Day Tally, CPU) is
defined in `CONTEXT.md` and used exactly as written. "Bot" always means the
Discord bot, never a CPU.

## The three files

| File | Role |
|---|---|
| `brawl-sim.js` | The simulation. Pure, dependency-free, no `Math.random`, no `Date.now`. **Both** the server and the browser run this exact file. |
| `brawl.js` | The server: the 30Hz loop, the WebSocket protocol, the ledger, the routes. Registered from `app.js` like every other feature module. |
| `brawl-page.js` | The page: SSR'd HTML plus the canvas renderer, netcode, and input handling as one inline module script. |

### Why the simulation is one shared file

This codebase has been bitten twice by hand-maintained client/server replicas
drifting — most recently `computeRatesFor` in `game.js` silently dropping
`building_synergy`, which understated everyone's /s until a page load quietly
corrected it. A fighting game would fail the same way, but visibly and every
frame. So the browser fetches `/brawl/sim.js`, which streams `brawl-sim.js`
off disk. There is no second copy to drift.

The rule that keeps that possible: **`brawl-sim.js` imports nothing and
contains no impurity.** No `node:` builtins, no npm, no `Math.random()`, no
`Date.now()`. Randomness comes from `state.seed` through the module's own LCG,
because the client's prediction must land on the same frame the server
computed.

## Netcode

- Fixed **30Hz** tick, driven by an accumulator rather than a bare interval: a
  chart render or a Claude call can stall the event loop for hundreds of
  milliseconds, and the Arena should catch up afterwards instead of quietly
  running in slow motion. Catch-up is capped at 500ms so a long stall drops
  frames rather than spiralling.
- **Snapshots go out every 2nd tick (15Hz).** The client predicts its own
  Fighter with the shared sim and eases everyone else toward the server's
  positions, so 15Hz of truth looks like 60fps of motion.
- **Events buffer between snapshots.** A snapshot carries every hit, KO, and
  respawn since the previous one, not just the ones from its own tick. Sending
  only the current tick's events silently dropped half of every fight — hit
  sparks that never appeared and, worse, KOs the client never learned about.
- **Queued input frames are merged, not replaced.** A client sends at ~30Hz,
  but the server can tick slower for a moment under load, and "newest frame
  wins" then eats whichever presses landed in between: the tap simply doesn't
  happen. Merging keeps the newest directions and ORs the action buttons, so a
  press is never swallowed while the release still arrives on a later frame,
  which is what edge-triggering needs.
- **Input frames carry a sequence number.** The server drops any frame whose
  `seq` is not greater than the last it applied, and the client drops any
  snapshot older than the one it already drew. Same rule as GlizzyClicker's
  `save_seq` / `adoptServerState`, for the same reason: a queued frame from a
  suspended tab is stale, not news.
- **The `ack` echo sets the reconciliation tolerance.** Each snapshot echoes
  the newest input frame the server applied, and the client widens its
  snap-back threshold in proportion to how many frames are still
  unacknowledged. A snapshot that predates your recent inputs is *supposed* to
  disagree; snapping on it yanks the Fighter backwards whenever latency ticks
  up.
- **Prediction is only ever positional.** Percent, KOs, Falls, and streaks are
  copied from the server every snapshot and never guessed. When the predicted
  position drifts more than 60px from the server's, the client snaps.
- **The Arena sleeps when nobody is connected** — the interval is cleared and
  the stage emptied, so an idle Arena costs no CPU. With spectators watching but
  no Fighters in the stage, physics don't run either; those spectators just get
  a keep-alive snapshot every couple of seconds.

### Protocol

Client → server: `join {character}`, `input {seq, ...buttons}`, `cpu {count}`,
`leave`.

Server → client: `hello` (stage, roster, cap, your cosmetics, scoreboard),
`joined`, `denied {reason}` (`auth` | `full` | `cpu_not_alone` | `cpu_limit`),
`waiting {place, waiting, cap}`, `snap` (fighters, projectiles, notable events,
spectator count, `ack`), `despawned {reason}`, `cpus`, `score`.

Identity rides the existing Discord OAuth session cookie on the upgrade
request. Spectating needs no session; fighting does. Dev-bypass mode works
here exactly as it does for GlizzyClicker.

## Controls

Gamepad on a fixed Smash layout (left stick / D-pad, A or Y jump, X light, B
heavy, right trigger special, left bumper/trigger dodge), and on the keyboard
WASD *and* the arrows are live at once with no picker.

**Jump is Space, not W / Up.** Sharing a key between jump and the "up"
direction makes every ground up-attack jump first and come out as its aerial
version, which quietly deletes half the ground moveset. Dodge is Shift.

## Combat

Run, double jump, fast-fall, drop-through, light and heavy with direction
variants on the ground and in the air, a cooldown dodge, and one special per
Fighter. **No shield and no grabs** — the shield→grab→throw complexity cliff
was declined deliberately.

Knockback is `(baseKb + percent × kbGrowth) × (100 / weight)`, so the same hit
sends a Fighter farther the higher their Percent and less far the heavier they
are. Percent has no ceiling and never kills by itself.

Roster: **The Glizzy** (balanced, Snap bite-lunge), **Ketchup** (fast/light,
Splat slowing blob), **The Grill** (heavy, Flare-Up launcher), **Corn Dog**
(disjointed reach, Pogo downward spike).

### Non-obvious mechanics decisions

- **A grounded attack plants your feet** (`vx *= 0.2` on startup, decayed each
  frame after). Without this, an attack begun mid-run keeps every pixel of that
  run: you slide straight past your own hitbox and frequently off the ledge,
  which reads as the attack simply not working. This was a real bug, caught by
  the WebSocket tests before it was ever played.
- **Snap's lunge stops when the bite comes out.** A lunge that keeps its speed
  through the active frames outruns its own hitbox.
- **Spawning grants ~1s of intangibility.** Dropping into a live brawl should
  never be an instant Fall. `spawnFighter({invuln: 0})` opts out, which is what
  the mechanics tests use.
- **KO credit expires after 8 seconds.** Long enough for any plausible fall,
  short enough that a stale hit never steals someone's self-destruct.

## Scoreboards and the ledger

One SQLite table, `brawl_stats`, one row per player ever — there is no match
or bout concept to hang a row on, by design. It holds lifetime KOs, Falls,
best KO Streak, Arena seconds, and per-character KOs, plus the Pacific Day
Tally (`day_key`, `day_kos`, `day_falls`) which rolls over lazily the first
time a player scores on a new Pacific day. All day bucketing goes through
`stats.js: toPacificDateKey`, like every other date in the project.

Rows are written at KO / despawn / disconnect time, never per tick.

## Fairness rules

- **AFK**: ~60s with no button press and your Fighter fades out; any button
  brings them back with no menu. KOs against an idle player count right up to
  the moment the fade completes — tabbing out mid-fight has honest
  consequences.
- **CPUs** are spawnable only while exactly one human is in the Arena, fade out
  over ~1s when a second human joins, and leave **zero** persistent stats.
  Because CPUs and a second human can never coexist, "are there CPUs in the
  Arena?" is the whole test — no KO ever needs human-vs-CPU disambiguation.
  Arena time doesn't accrue during practice either.
- **Cap** is 8 Fighters. Arrivals beyond that spectate, are told their place in
  line ("you're #2 of 3 waiting"), and are pulled in automatically — oldest
  wait first — the moment a slot frees. Leaving voluntarily gives up your
  place; being disconnected doesn't hold one.
- **CPU cap** is 3, and asking for more is refused rather than silently capped.

## Cosmetics

`computeCosmetics(userId)` derives crowns (streak tiers), trails, and finishes
(lifetime tiers) from real hot dog stats at spawn — "finish", not "skin", which
`CONTEXT.md` reserves. Results are cached for a minute because deriving a
streak scans every hot dog event and this runs on hello, join, and page render. This reverses the original
pitch on purpose: hot dog stats decorate a Fighter and **never** touch weight,
speed, damage, reach, or knockback. Nothing gameplay-shaped may be added to
that function's output.

## Art

Fighter bodies are Kenney's CC0 **Platformer Characters 1** (licence text lives
in `assets/brawl/LICENSE-kenney.txt`; credit is optional but the page gives it
anyway). Each body ships `stand / walk1 / walk2 / jump / fall / duck / hurt`
plus three attack poses — `action1`, `kick`, `action2` — which `poseFor` maps
to light, heavy, and special. That mapping is why the three attacks read as
different moves without the sim knowing anything about art.

All four Fighters now draw sprites of their own, generated through PixelLab and
imported into `assets/brawl/` — see [the art recipe](glizzybrawl-art-brief.md).
The costume layer that used to paint a bun, a bottle, a lid or batter over a
borrowed body is **gone**, and so is the manifest list that named which Fighters
had escaped it: once the list named everyone, it and the branch it fed were
dead weight, and two ways to draw a Fighter is how a renderer and its preview
quietly disagree. `bodyFor` is now `cpu ? zombie : character`.

CPUs keep a Kenney body deliberately, so a practice partner is never mistaken
for a person. That zombie is the only borrowed art left in the Arena; the other
four bodies from the pack were deleted with the costumes.

- **Signature flourishes belong to the special alone** — the ketchup splat, the
  grill's coals. Firing them on every jab made all three attacks look the same.

### Flourishes are their own layer

The signature-move effects used to live *inside* the costumes, which meant
giving a Fighter art of its own silently deleted them — the costume was gated
on the manifest and the flourish went through the gate with it. The Grill is the
case that matters: Flare-Up's 16-frame wind-up is telegraphed entirely by the
coals, and without them a stock-ending launcher reads as instant.

They now live in `FLOURISHES` in `brawl-art.js`, keyed by the special's name in
the sim, and `drawFlourish` runs for **every** Fighter, whichever sprite set it
draws.
Deciding whether one is showing is separate from drawing it: `flourishFor`
is a pure function of a Fighter snapshot returning `{ id, progress }` or
`null`, and it is the unit `test/brawl-art.test.js` pins. Two rules it carries:

- Progress comes from the attack's **own frame counter**, never the clock, so a
  telegraph cannot drift away from the hitbox it is warning about.
- A back-layer flourish must be **wider than a Fighter**. A single flame up the
  centre line was entirely hidden behind the body and telegraphed nothing.

Ketchup's Splat flourish stays on the Fighter — a squeeze at the nozzle, not a
travelling blob. The blob in flight is a real projectile the renderer already
draws, and a second one means the player cannot tell where the shot is.

`brawl-art.js` follows the same shared-file rule as the sim: no imports, no
browser-only globals beyond the 2D context it is handed. That is what lets
`scripts/brawl-art-preview.mjs` render the whole roster to a PNG with
node-canvas and have it match the Arena exactly:

```bash
node scripts/brawl-art-preview.mjs        # writes brawl-roster.png
```

### Importing art

Each Fighter draws `<character>_<pose>.png` from `assets/brawl/`, so replacing a
Fighter's look is dropping ten files in — no restart, no code change. While art
was landing one Fighter at a time the manifest carried a `bespoke` list and the
renderer branched on it; with every Fighter converted, that list and the
costumes it gated are gone. The manifest now carries frame geometry only.

`scripts/brawl-import-sprites.mjs` does the import: background removal, trim,
one uniform scale across the whole set (so a duck stays shorter than a stand),
feet planted on the floor line, and the manifest entry.
`scripts/brawl-art-measure.mjs` gates the keyframe picks on measured
thresholds before any of that. See
[the art brief](glizzybrawl-art-brief.md) for what to generate and how to feed
it in.

**`--frame-width` is the apparent-size dial.** The renderer normalises every
sprite to `SPRITE.drawHeight` and takes the aspect from the image, so a
Fighter's on-screen size is the fraction of frame height its art fills — and
the importer's shared scale factor is set by the *widest* pose. Corn Dog's
stick thrust pinned the whole Fighter small until its frame was widened to 150.
An override records itself per Fighter in the manifest rather than moving the
roster default, so retuning one Fighter cannot resize the next. Tuning size is
always a re-import, never a regeneration.

`scripts/brawl-make-sprites.mjs` builds a pixel-art prototype set from ASCII
rigs — rough, but a worked example of the bespoke path end to end.

Swapping art wholesale means replacing `assets/brawl/` and the tables at the
top of `brawl-art.js`; nothing else knows what a Fighter looks like.

Known shortfalls against the measured gates, all documented in the art brief
with why more generations were not the fix: **every crouch fails** — Corn Dog at
79% of standing height against a 75% gate, Ketchup and The Grill at 93%, which
does not read as ducking at all — and The Grill's attacks reach +9px against a
+15px gate, which is a fifth of its own body width and all a round kettle with
stub arms has. The hurt gate's "lift off the floor line" also does not survive
import, since the importer plants every frame on the floor line; it selects the
frame where the body is flung, and the tilt is what ships.

Apparent size runs ~15% across the roster as intended: The Grill fills 84.5% of
its frame height and everyone else 97.3%, tuned entirely with `--frame-width`.

## Testing

`npm test` runs both suites with Node's built-in `node:test` — no new
dependencies, and the first tests in the repo.

- `test/sim.test.js` — frame-precise mechanics against the sim's real public
  API (the same API the browser consumes): knockback scaling, blast-zone KOs,
  double jump, dodge cooldown, drop-through, fast-fall, each special,
  determinism.
- `test/brawl-ws.test.js` — the primary seam. Boots the real Express app
  against a temporary SQLite file, connects genuine `ws` clients carrying
  genuine signed session cookies, and asserts only on what a client observes
  and what the ledger records: login gating, KO persistence, Day Tally vs
  all-time, AFK despawn and rejoin, CPU solo-only gating and statlessness,
  reconnection, the stale-input guard, and the full-Arena spectate path.

`BRAWL_TEST_MODE=1` shrinks the 60s AFK rule to 2s so it is testable and
demoable locally, following the `GLIZZY_TEST_MODE` precedent. **Never set it in
production.**

The Arena runs in real time, so the WebSocket suite genuinely takes ~20s.

## Deploys

Railway restarts the process on every deploy and in-flight Arena state is
intentionally ephemeral. Nobody loses a match because there are no matches;
clients reconnect with backoff and rejoin automatically, and ledger writes at
KO/despawn time bound the loss window to whatever happened in the last few
seconds.
