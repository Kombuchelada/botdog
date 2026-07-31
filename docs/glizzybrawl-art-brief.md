# GlizzyBrawl — Fighter art recipe

How a Fighter gets bespoke art, end to end, using the PixelLab MCP server.
The Glizzy was built this way; the other three follow the same path.

The Arena treats art as swappable: `assets/brawl/manifest.json` records which
Fighters have art of their own, and those stop getting a costume drawn over a
borrowed Kenney body. So this is a **one-Fighter-at-a-time** process — convert
Corn Dog, play it, and the rest keep their current look until you're happy.

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
  description = "cartoon ketchup bottle character, red glass bottle with a cap
                 for a head, cartoon arms and legs, friendly face, lean and
                 top-heavy",
  style_image_url = <The Glizzy's south rotation>,
  style_copy = ["color_palette", "outline", "detail", "shading"],
  width = 64, height = 64)
```

It returns a grid of candidates in one call (64 of them at ≤42px, 16 at ≤85px),
so you still pick the one you like — but every candidate is already locked to
The Glizzy's palette and outline weight. Cost 20–40 generations.

## Step 2 — the character

```
create_character(
  description = <same subject line>,
  mode = "v3", view = "side", size = 64,
  reference_image_base64 = <the chosen 64x64 cell>)
```

1 generation, ~8 minutes. v3 is the only mode that accepts a reference. It
always produces 8 rotations; only **south-east** is used, and its rotation PNG
is `stand` for free.

## Step 3 — the animations

Fire **both** a template and a v3 custom for every pose in one batch, then keep
whichever reads better per pose. A round trip is ~5 minutes whether it carries
one job or twenty, and credits are the cheap resource.

Always `directions: ["south-east"]` — the game needs one facing, and animating
all eight costs 8× for art that is never drawn.

Always `frame_count: 4` on v3 customs. Cost is
`ceil(canvas × frames ÷ 65536)` per direction, so 4 frames on a 124px canvas
costs **1** generation and 6 frames costs **2** — and only one frame per pose
is ever kept.

| Pose | Template to try | v3 custom description |
|---|---|---|
| `walk1`/`walk2` | `walking` | walking with big bouncy exaggerated steps, whole body squashing and stretching, arms swinging wide |
| `jump`/`fall` | `jumping-1` | — (the template gives 9 frames to choose from) |
| `duck` | `crouching` | hunkering down low, legs bent deep and body squashed short and wide, head held up and facing forward |
| `hurt` | `taking-punch` | knocked backwards hard, body flung back and tilted, head snapped away, arms flung outward, feet leaving the ground |
| `action1` | `lead-jab`, `cross-punch` | punching forward hard, arm fully extended at full reach, body leaning into the punch |
| `kick` | `high-kick` | — |
| `action2` | none | per-Fighter, from the specials table above |

**Expect the templates to lose.** They are humanoid skeleton animations and
these characters have stub limbs, so there is no thigh or upper arm to rotate.
On The Glizzy only `jumping-1` and `high-kick` survived; `walking`,
`crouching`, `taking-punch`, `lead-jab` and `cross-punch` were all rejected for
producing almost no visible motion. Generate both anyway — the failure mode
differs by body shape, and a losing variant costs one generation.

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
- **hurt** shows lift — feet off the floor line (`taking-punch` gave zero)

Measure the alpha bounding box, not `sharp.trim()`, which keys off the
top-left pixel and returns the full canvas on transparent art.

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

**The Glizzy** — character `3cb0cf71-9e50-465b-b3b7-053149b71f01`,
account prefix `3a6ffff3-54a7-40b4-a199-91fc10560ec0`.

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
because those were drawn inside `COSTUMES` and `wearsCostume` returns false for
bespoke Fighters. They now live in `FLOURISHES` in `brawl-art.js` and are drawn
for every Fighter, so converting a Fighter no longer costs it its special.

That means a Fighter's `action2` sprite only has to carry the *pose*. The
effect is already on screen:

| Fighter | Flourish | The sprite shows |
|---|---|---|
| Ketchup | sauce burst at the nozzle | the **squeeze**, never a blob |
| The Grill | coals roaring through the wind-up | the lid rearing back |
| Corn Dog | none | the downward stab, stick pointing down |
| The Glizzy | none | the bite-lunge |
