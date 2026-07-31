# GlizzyBrawl — Fighter art recipe

How a Fighter gets bespoke art, end to end, using the PixelLab MCP server.
All four Fighters have been through it — The Glizzy first, then Corn Dog,
Ketchup and The Grill — and everything below is what that cost to learn.

`assets/brawl/manifest.json` lists which Fighters draw sprites of their own, and
it is the only thing that decides. A Fighter dropped from that list falls back
to a borrowed Kenney body, which is what makes a conversion the owner dislikes
a one-line undo, and what made this a one-Fighter-at-a-time process rather than
a big-bang swap.

## The four Fighters

| Fighter | What it is | Proportions to prompt for | Special (from `brawl-sim.js`) |
|---|---|---|---|
| **The Glizzy** | A frankfurter in a bun | Balanced, middleweight | **Snap** — a bite-lunge |
| **Ketchup** | A ketchup bottle | Lean, top-heavy, twitchy | **Splat** — a thrown projectile |
| **The Grill** | A charcoal kettle grill | Squat, wide, planted | **Flare-Up** — 16-frame wind-up, then a vertical launcher |
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

## The ten poses

```
stand   walk1   walk2   jump   fall
duck    hurt    action1 kick   action2
```

`action1` is the light attack, `kick` the heavy, `action2` the special.

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
reference carries a little pennant flag, and it is in all ten of its poses.
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
costs **1** generation and 6 frames costs **2** — and only one frame per pose
is ever kept.

| Pose | What to send | Prompt |
|---|---|---|
| `walk1`/`walk2` | v3 custom | walking with big bouncy exaggerated steps, whole body squashing and stretching, arms swinging wide |
| `jump`/`fall` | `jumping-1` template | — (9 frames to choose from; the one template worth sending) |
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

## Step 4 — picking keyframes

One frame per pose. Measure rather than eyeball — both defects found on The
Glizzy were caught by measurement after passing a visual check:

- **crouch** ≤ 75% of standing height (the `crouching` template gave 89%, which
  does not read as a crouch at all)
- **attacks** ≥ +15px of extension over the standing bounding box (`lead-jab`
  gave +3px; the v3 custom gave +28px)
- **hurt** ≥ 3px of lift off the floor line (`taking-punch` gave zero — and a
  template that visibly does nothing still drifts a pixel, so "any lift" is not
  a gate)

```bash
node scripts/brawl-art-measure.mjs <working-folder>
```

It reads `stand.png` plus one subfolder of numbered frames per animation, and
prints height %, extension and lift per frame with a PASS/fail against the
gates above. It measures the **alpha bounding box**, not `sharp.trim()`, which
keys off the top-left pixel and returns the full canvas on transparent art.

**Measure *and* look.** The gate catches poses that look fine and measure
wrong; it cannot catch the inverse. Ketchup's crouch prompt "sink down until
sitting on the ground" measured a beautiful 65% by tipping the bottle over onto
its side. A pass is permission to look, not a substitute for looking.

**The crouch is the pose this pipeline cannot do.** Six attempts across three
Fighters: v3 tilts these bodies rather than compressing them, and only the
tip-over — which reads as death, not ducking — ever cleared 75%. Corn Dog ships
at 79% and Ketchup and The Grill in the low 90s. If the duck has to read
properly, the next thing to try is the renderer squashing the stand frame
vertically, not another generation.

**A Fighter can be physically incapable of +15px.** The Grill is a round kettle
with stub arms; its best attack reaches +9px, which is a fifth of its own body
width. The threshold is a Glizzy-shaped absolute and the roster is not one
shape. Take the best of three and move on.

## Step 5 — import and review

```bash
node scripts/brawl-import-sprites.mjs <fighter> <folder>/ --keep-bg
node scripts/brawl-art-preview.mjs      # writes brawl-roster.png
```

Name the files `stand.png`, `walk1.png`, … in the folder. `--keep-bg` is right
for PixelLab output, which has real alpha — without it the importer tries to
flood-fill a background that isn't there.

The importer trims, scales **every frame by one shared factor** (so a duck
stays shorter than a stand), plants each frame on the floor line, writes
`assets/brawl/<fighter>_<pose>.png`, and adds the Fighter to `manifest.json`.

**`FRAME.width` is the size dial.** The renderer normalises every sprite to
`SPRITE.drawHeight` and takes the aspect from the image, so how big a Fighter
looks is the fraction of frame height its art fills. The shared scale factor is
set by the *widest* pose — usually a fully extended attack — so a narrow frame
pins the whole Fighter small and leaves dead space above the head. 110×110
makes height the binding constraint. Narrow it to shrink a Fighter; widen it to
grow one. No regeneration needed, and re-importing is a two-second round trip.

Reload `/brawl` — no restart needed, the manifest is re-read per request.

## Re-fetching frames without spending anything

`pixellab/` is gitignored, but PixelLab keeps every character and animation
group server-side. `get_character(character_id)` returns download URLs for all
of them, so any keyframe can be re-picked for free as long as the IDs survive.

Account prefix for all four: `3a6ffff3-54a7-40b4-a199-91fc10560ec0`.

| Fighter | Character id | Reference (`create_image_pro` job, cell) |
|---|---|---|
| The Glizzy | `3cb0cf71-9e50-465b-b3b7-053149b71f01` | web interface |
| Corn Dog | `b7484139-9183-464f-84be-3c4466b6c706` | `2166c513-9d38-43d4-b7c8-96f59910ec88` #13 |
| Ketchup | `1f4d160e-4f8c-45be-96ef-7682f5238a4c` | `1b269daf-48ec-496c-a806-fb8ad244ba90` #0 |
| The Grill | `994c950d-c600-4211-9731-1e11742a95ca` | `cd246fb5-2895-4938-8006-6369e10db5b6` #0 |

`get_character(<id>)` lists every animation group with download URLs, so any
keyframe can be re-picked for free. The frames kept for the three Fighters
converted here are named after their animation groups (`walk-v3`, `jab-stick`,
`duck-compress`, `hurt-airborne`, `flare-open`, `pogo-stick-down`, …).

Frames are at
`https://backblaze.pixellab.ai/file/pixellab-characters/<account>/<character>/animations/<animation>/south-east/<n>.png`.

| Pose | Kept | Animation id |
|---|---|---|
| `stand` | south-east rotation | — |
| `walk1`, `walk2` | f4, f6 | `b18777bc-3551-4536-8ee6-e958484b0c06` (walk-v3) |
| `jump`, `fall` | f2, f7 | `93bc02d7-3812-47bd-8627-64af4b6cdea1` (jumping-1) |
| `duck` | f4 | `b6f27e5d-322c-4fd3-b615-ce4c363176e3` (duck-hunker) |
| `hurt` | f3 | `4f5b0993-69d0-41e3-958c-d6cd62251199` (hurt-v3) |
| `action1` | f4 | `e47c9786-1d36-4a20-b08a-9ac32803e80a` (jab-v3) |
| `kick` | f2 | `24df09e2-149b-44e7-a14c-563b1387fdc3` (high-kick) |
| `action2` | f5 | `506d2d02-56f8-43c0-9c45-25b555473b0f` (bite) |

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
special. (The costume layer itself is gone — with all four Fighters bespoke it
had no users left.)

That means a Fighter's `action2` sprite only has to carry the *pose*. The
effect is already on screen:

| Fighter | Flourish | The sprite shows |
|---|---|---|
| Ketchup | sauce burst at the nozzle | the **squeeze**, never a blob |
| The Grill | coals roaring through the wind-up | the lid rearing back |
| Corn Dog | none | the downward stab, stick pointing down |
| The Glizzy | none | the bite-lunge |
