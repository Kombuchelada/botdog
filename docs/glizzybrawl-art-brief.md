# GlizzyBrawl — Fighter art recipe

How a Fighter gets bespoke art, end to end, using the PixelLab MCP server.
All four Fighters have been through it — The Glizzy first, then Corn Dog,
Ketchup and The Grill — and everything below is what that cost to learn.

Each Fighter's actions are **animated**, not posed. An action is a *clip* — an
ordered run of frames — and a Fighter draws `<character>_<clip>_<n>.png` from
`assets/brawl/`, so replacing one is a matter of pointing the importer at a
folder of animation folders. While conversions were in flight the manifest
carried a list of which Fighters had art of their own and the renderer branched
on it, which is what made this a one-Fighter-at-a-time process; all four are
converted now, so that list and the costume system are gone and the manifest
carries frame geometry only.

Clip *lengths* don't live in the manifest either. They are in `CLIPS` in
`brawl-art.js`, where the browser reads them without a fetch and where they are
readable next to the code that plays them — the same call the Stage's `LAYOUT`
makes. The importer imports that table and satisfies it; it never writes it.

## The four Fighters

| Fighter | What it is | Proportions to prompt for | Special (from `brawl-sim.js`) |
|---|---|---|---|
| **The Glizzy** | A frankfurter in a bun | Balanced, middleweight | **Snap** — a bite-lunge |
| **Ketchup** | A ketchup bottle | Lean, top-heavy, twitchy | **Splat** — a thrown projectile |
| **The Grill** | A charcoal kettle grill | Squat, wide, planted | **Flare-Up** — 12-frame wind-up, then a vertical launcher |
| **Corn Dog** | A battered sausage on a stick | Tall and thin | **Pogo** — a downward stab that spikes |

The food *is* the character — arms and legs on the food itself, not a person
holding food or wearing a costume. That was tried and rejected twice.

**Take the specials from the sim, not from memory.** `MOVES` in `brawl-sim.js`
is authoritative, and Ketchup's Splat is a *real projectile* that
`brawl-page.js` already draws — so its `action2` sprite shows the **squeeze**
and never the blob, or you get two blobs.

**Aim for about a 15% spread in apparent size** across the roster (Grill
shortest, Corn Dog tallest). Don't go further: all four share one hurtbox
(`BODY = { halfWidth: 18, height: 54 }`), so size differences are already a
small lie about where a Fighter can be hit.

## Facing

**South-east.** A 3/4 view turned toward the camera, not a profile — see
[ADR 0002](adr/0002-food-characters-face-three-quarter.md). A food character
has no readable profile; the side view is a featureless lump. The renderer
mirrors for left-facing, and that has been played and judged fine.

## The nine clips

| Clip | Frames | What drives it |
|---|---|---|
| `stand` | 1 | — |
| `walk` | 4 | a clock, paced by how fast the Fighter is moving |
| `jump` | 3 | vertical velocity, from launch to the apex |
| `fall` | 3 | vertical velocity, from the apex to terminal |
| `duck` | 3 | the dodge's own tick counter |
| `hurt` | 3 | the hitstun the sim reports, played forward as it drains |
| `action1` | 4, contact 2 | the attack's frame counter against the move's frame data |
| `kick` | 4, contact 2 | ” |
| `action2` | 4, contact 2 | ” |

`action1` is the light attack, `kick` the heavy, `action2` the special.

**Only the walk is on a clock.** Everything else is driven by sim state, which
is what makes the animation honest: a Fighter hanging at the apex holds the
apex frame however long the hang lasts, and a wind-up cannot drift out of step
with the hitbox it warns about under a slow tick.

**`contact` is the frame of maximum extension, and it is load-bearing.** The
renderer pins it to the move's first *active* frame, so wind-up plays over the
startup, contact is held for exactly as long as the hitbox exists, and the rest
plays out over the endlag. One clip per attack therefore reads correctly on a
2-frame jab and a 12-frame launcher alike, and a player who learns to watch for
the extension is watching the real hitbox.

## Step 1 — the reference sprite

One `create_image_pro` call per Fighter, anchored to The Glizzy's style so the
roster reads as one set:

```
create_image_pro(
  description = "cartoon ketchup bottle character, red squeeze bottle body with
                 a cap for a head, small cartoon arms and legs on the bottle
                 itself, friendly face, lean and top-heavy, standing,
                 three-quarter view facing down-right",
  style_image_url = <The Glizzy's south rotation>,
  style_copy = ["color_palette", "outline", "detail", "shading"],
  width = 64, height = 64)
```

It returns a grid of candidates in one call (64 of them at ≤42px, 16 at ≤85px),
so you still pick the one you like — but every candidate is already locked to
The Glizzy's palette and outline weight. Cost 20–40 generations.

**Style anchoring holds across subjects.** This was the one untested assumption
in the plan, and Corn Dog settled it: a hot dog anchoring a corn dog, a bottle
and a kettle grill produced three full grids on palette and outline weight.
Validate on one Fighter before spending on the rest anyway.

**Whatever the chosen cell is holding, the Fighter holds forever.** Corn Dog's
reference carries a little pennant flag, and it is in every frame of every
clip it has.
Props are a choice, not an accident — make it deliberately.

## Step 2 — the character

```
create_character(
  description = <same subject line>,
  mode = "v3", view = "side", size = 64,
  reference_image_base64 = <the chosen 64x64 cell>)
```

1 generation, 3–8 minutes. v3 is the only mode that accepts a reference. It
always produces 8 rotations; only **south-east** is used, and its rotation PNG
is `stand` for free. Pass `reference_image_url` rather than base64 — the
`create_image_pro` download URL works directly, and inline base64 gets
truncated by MCP clients.

## Step 3 — the animations

Fire the whole set in one batch. A round trip is ~5 minutes whether it carries
one job or twenty, and credits are the cheap resource — but the account runs at
most **8 jobs at once**, so a batch bigger than that comes back with
"need 1 job slots but only 0 available" and has to be re-sent.

Always `directions: ["south-east"]` — the game needs one facing, and animating
all eight costs 8× for art that is never drawn.

Always `frame_count: 4` on v3 customs. Cost is
`ceil(canvas × frames ÷ 65536)` per direction, so 4 frames on a 124px canvas
costs **1** generation and 6 frames costs **2**. Every frame is kept now — the
importer resamples the run down to the clip length, so a 4-frame job and a
7-frame one both land as a 4-frame clip and more frames only buy smoothness.

| Clip | What to send | Prompt |
|---|---|---|
| `walk` | v3 custom | walking with big bouncy exaggerated steps, whole body squashing and stretching, arms swinging wide |
| `jump`/`fall` | `jumping-1` template | — (one 9-frame job, split into both clips; the one template worth sending) |
| `duck` | v3 custom | compressing straight downward like a squashed spring, body staying perfectly upright and vertical without tilting, squashed to half its height and bulging wider, head low and level |
| `hurt` | v3 custom | blasted off its feet and flying backwards through the air, whole body airborne well above the ground and tilted back, legs kicked up off the ground |
| `action1` | v3 custom | *name the Fighter's own anatomy* — see below |
| `kick` | v3 custom | swinging one leg up and far forward in a huge high kick, leg fully extended out in front at maximum reach, body leaning back to counterbalance |
| `action2` | v3 custom | per-Fighter, from the specials table above |

**Don't send the humanoid templates.** They rotate a skeleton and these
Fighters have no thigh or upper arm to rotate. The brief used to say "send both
and keep the better one"; three Fighters in, the templates have won exactly
once. `jumping-1` is that once. `walking`, `crouching`, `taking-punch`,
`lead-jab`, `cross-punch` and `high-kick` have all been tried on more than one
body shape and produced almost no visible motion every time.

**Name the Fighter's own anatomy, not a human's.** Corn Dog's punch reached
+12px and failed the gate; the same pose described as *"thrusting the wooden
stick forward like a spear at full arm extension, whole body lunging far
forward"* reached +20px and passed. If a Fighter has a stick, a nozzle or a lid,
the attack should use it.

**Never write "friendly face" into a v3 description.** It reads as an
instruction to amplify the smile and comes back unsettling. To keep an
expression, say nothing about it; the reference already carries it.

## Step 4 — judging the animation

Clips keep whole animations, so there is no keyframe to pick any more — the
importer resamples the run and places the extreme frame itself. What is still
worth measuring is whether the animation *has* an extreme frame, because the
failure mode that made the humanoid templates useless is exactly a run of four
frames where nothing moves. Measure rather than eyeball — both defects found on
The Glizzy were caught by measurement after passing a visual check:

- **crouch** ≤ 75% of standing height (the `crouching` template gave 89%, which
  does not read as a crouch at all)
- **attacks** ≥ +15px of extension over the standing bounding box (`lead-jab`
  gave +3px; the v3 custom gave +28px)
- **hurt** ≥ 3px of lift off the floor line (`taking-punch` gave zero — and a
  template that visibly does nothing still drifts a pixel, so "any lift" is not
  a gate). Note the importer plants every frame on the floor line, so the lift
  itself does **not** ship: it is a proxy for "this is the frame where the body
  is actually flung", and what survives import is the tilt and the flung limbs.

```bash
node scripts/brawl-art-measure.mjs <working-folder>
```

It reads `stand.png` plus one subfolder of numbered frames per animation, and
prints height %, extension and lift per frame with a PASS/fail against the
gates above. It measures the **alpha bounding box**, not `sharp.trim()`, which
keys off the top-left pixel and returns the full canvas on transparent art.

The importer enforces the weaker version of this on every import (see Step 5),
so a dead animation cannot ship silently even if this step is skipped. Run this
anyway before spending another generation: it tells you *how* dead, which is
what decides whether to re-prompt or accept.

**Measure *and* look.** The gate catches poses that look fine and measure
wrong; it cannot catch the inverse. Ketchup's crouch prompt "sink down until
sitting on the ground" measured a beautiful 65% by tipping the bottle over onto
its side. A pass is permission to look, not a substitute for looking.

**The crouch is the pose this pipeline cannot do.** Six attempts across three
Fighters: v3 tilts these bodies rather than compressing them, and only the
tip-over — which reads as death, not ducking — ever cleared 75%. **All three
crouches ship failing the gate**: Corn Dog at 79%, Ketchup and The Grill at 93%,
where 93% is not distinguishable from standing. If the duck has to read
properly, the next thing to try is the renderer squashing the stand frame
vertically, not another generation.

**A Fighter can be physically incapable of +15px.** The Grill is a round kettle
with stub arms; its best attack reaches +9px, which is a fifth of its own body
width. The threshold is a Glizzy-shaped absolute and the roster is not one
shape. Take the best of three and move on.

## Step 5 — import and review

One `--clip` per action, naming the animation folder it comes from and
optionally a range of frames within it. This is the whole Glizzy import:

```bash
node scripts/brawl-import-sprites.mjs glizzy pixellab/ --keep-bg \
  --clip stand=walk-v3:0-0 --clip walk=walk-v3 \
  --clip jump=jump:2-4 --clip fall=jump:4-6 \
  --clip duck=duck-hunker --clip hurt=hurt-v3 \
  --clip action1=jab-v3 --clip kick=kick --clip action2=bite
node scripts/brawl-art-preview.mjs      # writes brawl-roster.png
```

`--keep-bg` is right for PixelLab output, which has real alpha — without it the
importer tries to flood-fill a background that isn't there. With no `--clip`
flags at all it looks for a subfolder per clip name instead.

The one 9-frame `jumping-1` job supplies both air clips: frames 2–4 are the
launch through the apex, 4–6 the apex through the fall. Frame 0 is a standing
anticipation and 7–8 a landing, and neither is ever drawn — the Fighter is
airborne for the whole of both clips.

The importer trims, resamples each run to its declared clip length, scales
**every frame of every clip by one shared factor** (so a duck stays shorter
than a stand *and* a wind-up stays smaller than the punch it leads to), plants
each frame on the floor line, writes `assets/brawl/<fighter>_<clip>_<n>.png`,
and records any frame-width override in `manifest.json`.

**Which frames it keeps depends on the action, and that is a real distinction.**
A `loop` (the walk) must not include both its first and last source frame or
the Fighter stutters once per stride. A `span` (jump, fall, hurt) plays evenly
start to end. A `peak` (both attacks, the special, and the duck) is built
*around* its most extreme frame: the importer measures which source frame that
is — silhouette area for an attack, height for a duck — and lands it on the
index `CLIPS` declares. Some of these animations peak halfway and recover; some
peak on their very last frame and have no recovery at all (Corn Dog's stick
thrust), in which case the clip walks back through its own wind-up rather than
holding a fully extended punch through the whole endlag, which reads as a
freeze.

**The extension gate.** An import fails if a `peak` clip's most extreme frame
is its *first*: there is nothing to place at contact, so the wind-up, the
hitbox and the recovery all draw the same picture and the move reads as the
game ignoring you. This is the +15px gate's cheap cousin, and it runs at the
moment the art changes rather than in `npm test` — same rule as the Stage's
import gates.

**`FRAME.width` is the size dial.** The renderer normalises every sprite to
`SPRITE.drawHeight` and takes the aspect from the image, so how big a Fighter
looks is the fraction of frame height its art fills. The shared scale factor is
set by the *widest* frame — usually a fully extended attack — so a narrow frame
pins the whole Fighter small and leaves dead space above the head. 110×110
makes height the binding constraint. Narrow it to shrink a Fighter; widen it to
grow one. No regeneration needed, and re-importing is a two-second round trip.

Reload `/brawl` — no restart needed, the manifest is re-read per request.

**The preview is a filmstrip, not a grid of stills.** `brawl-art-preview.mjs`
walks each action forward in real sim time and draws whatever `frameFor` picks,
shading the columns on which the move can actually hit. What it exists to check
is the *mapping*: the Fighter should look most committed inside the shading. A
grid of stills cannot show that, which is the whole reason the poses became
clips. It exits non-zero and paints a red box for any frame `CLIPS` promises
and the art does not have.

## Re-fetching frames without spending anything

`pixellab/` is gitignored, but PixelLab keeps every character and animation
group server-side. `get_character(character_id)` returns download URLs for all
of them, so a clip can be rebuilt for free as long as the IDs survive.

Account prefix for all four: `3a6ffff3-54a7-40b4-a199-91fc10560ec0`.

| Fighter | Character id | Reference (`create_image_pro` job, cell) |
|---|---|---|
| The Glizzy | `3cb0cf71-9e50-465b-b3b7-053149b71f01` | web interface |
| Corn Dog | `b7484139-9183-464f-84be-3c4466b6c706` | `2166c513-9d38-43d4-b7c8-96f59910ec88` #13 |
| Ketchup | `1f4d160e-4f8c-45be-96ef-7682f5238a4c` | `1b269daf-48ec-496c-a806-fb8ad244ba90` #0 |
| The Grill | `994c950d-c600-4211-9731-1e11742a95ca` | `cd246fb5-2895-4938-8006-6369e10db5b6` #0 |

`get_character(<id>)` lists every animation group with download URLs, so a clip
can be rebuilt for free. The working folders under `pixellab/` are named after
their animation groups (`walk-v3`, `jab-stick`, `duck-compress`,
`hurt-airborne`, `flare-open`, `pogo-stick-down`, …), which is exactly what the
`--clip` flags name.

Frames are at
`https://backblaze.pixellab.ai/file/pixellab-characters/<account>/<character>/animations/<animation>/south-east/<n>.png`.

The Glizzy's, as an example — the other three differ only in which group is
named, and `stand` is now frame 0 of the walk rather than the rotation, so a
Fighter at rest matches the frame its walk cycle starts from.

| Clip | Source | Animation id |
|---|---|---|
| `stand` | walk-v3 f0 | `b18777bc-3551-4536-8ee6-e958484b0c06` (walk-v3) |
| `walk` | walk-v3, all 7 | ” |
| `jump` | jumping-1 f2–4 | `93bc02d7-3812-47bd-8627-64af4b6cdea1` (jumping-1) |
| `fall` | jumping-1 f4–6 | ” |
| `duck` | duck-hunker, all | `b6f27e5d-322c-4fd3-b615-ce4c363176e3` (duck-hunker) |
| `hurt` | hurt-v3, all | `4f5b0993-69d0-41e3-958c-d6cd62251199` (hurt-v3) |
| `action1` | jab-v3, all | `e47c9786-1d36-4a20-b08a-9ac32803e80a` (jab-v3) |
| `kick` | high-kick, all | `24df09e2-149b-44e7-a14c-563b1387fdc3` (high-kick) |
| `action2` | bite, all | `506d2d02-56f8-43c0-9c45-25b555473b0f` (bite) |

Rejected variants are still on the account too, should a pick need revisiting:
`791d8592` (walking template), `538bf01a` (running-6-frames), `d3d40041`
(crouching template), `db9562fb` (duck-v3), `33ebc088` (duck-neutral),
`cf806279` (lead-jab), `907ececb` (cross-punch), `3db7f01f` (taking-punch).

## Flourishes are not the costume's job

Converting a Fighter to bespoke used to **remove its special-move flourish** —
the splat leaving Ketchup's nozzle, the coals roaring on The Grill's flare —
because those were drawn inside the costume layer, which a Fighter with art of
its own does not get. They now live in `FLOURISHES` in `brawl-art.js` and are
drawn for **every** Fighter, so a conversion no longer costs a Fighter its
special. (The costume layer itself is gone — with all four Fighters
converted it had no users left.)

That means a Fighter's `action2` clip only has to carry the *motion*. The
effect is already on screen — and it now runs alongside a real wind-up, which
is what The Grill's 12-frame Flare-Up always wanted:

| Fighter | Flourish | The clip shows |
|---|---|---|
| Ketchup | sauce burst at the nozzle | the **squeeze**, never a blob |
| The Grill | coals roaring through the wind-up | the lid rearing back |
| Corn Dog | none | the downward stab, stick pointing down |
| The Glizzy | none | the bite-lunge |
