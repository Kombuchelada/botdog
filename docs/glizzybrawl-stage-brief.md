# GlizzyBrawl — Stage art plan (the Ballpark)

> **Built** in `21153ca`. All nine props are in `assets/brawl/`, the code seam
> is `brawl-stage.js` + `scripts/brawl-import-stage.mjs` +
> `scripts/brawl-stage-preview.mjs` + `test/brawl-stage.test.js`, and the
> "Deliberately later" list at the bottom is still later. What this plan got
> wrong, and what the build learned, is in [As built](#as-built).

How the Arena's placeholder stage becomes the **Ballpark**, using the PixelLab
MCP server. Same shape as [the Fighter art recipe](glizzybrawl-art-brief.md),
for the other half of what's on screen.

Vocabulary is in [CONTEXT.md](../CONTEXT.md): the **Arena** is the never-ending
fight, the **Stage** is the place it happens in, the **Ballpark** is the one
Stage, and a **Catwalk** is one of its three soft platforms.

## What's there now

The entire Stage is ~20 lines of canvas primitives in `brawl-page.js`
(`draw`, `drawBlastZone`, `drawStage`): a vertical sky gradient
`#0b1220`→`#050a17`, a brown slab with a 6px `#ff6b35` lip for the ground,
three orange bars for the Catwalks, a dashed grey blast-zone rectangle.
No assets at all.

Geometry is owned by `STAGE` in `brawl-sim.js` and is **not** changing:

```
width 1280 × height 720
ground     x 240–1040, y 520     ← floats; you can fall off either end
platforms  x 340–560  y 380
           x 720–940  y 380
           x 530–750  y 250
blast      left -180, right 1460, top -340, bottom 900
```

## The fiction

A **night game, seen from the outfield.** Fighters brawl on the padded cap of
the outfield wall and the scoreboard rig behind it; light towers overhead,
crowd in the stands, dark sky above. Falling off either end of the ground drops
you behind the wall into the dark.

Two constraints drove this and both are load-bearing:

- **The ground floats.** A ballpark field has no edges to fall off, so the
  main platform can't be the field. The top of the outfield wall is the one
  surface in a ballpark that genuinely has a top, two ends, and a drop.
- **The Stage must stay dark.** The HUD draws white text straight onto the
  canvas with no plate behind it, the blast zone is a faint light-grey dash,
  and every Fighter sprite carries a dark outline. A day game means redesigning
  all three, and reopens the roster's outline treatment.
  See [ADR 0003](adr/0003-the-stage-is-a-night-scene.md).

## Scale

A Fighter's source PNG is 110px tall, drawn at `SPRITE.drawHeight = 70` on the
1280×720 canvas, generated at 64px — so **one art pixel ≈ one canvas pixel**.
Stage art has to live near that scale or it reads as a different game.

PixelLab caps images at 400×400, so a single 1280×720 backdrop is impossible in
one call, and the upscale alternatives both lose: ×4 from 320×180 gives pixels
4× chunkier than the Fighters, ×3.2 from 400×225 gives unevenly-wide pixels on
exactly the hard edges a scoreboard is made of.

So the backdrop is **composed from props at native scale**, not painted as one
image. Each piece is separately re-rollable, and a bad crowd costs a crowd
re-roll instead of a whole backdrop.

## The pieces

| # | File | Source | Notes |
|---|---|---|---|
| 1 | `board_main.png` | `create_image_pro`, anchored to a Fighter | ~400×260, drawn once. Style anchor for everything below. Carries the empty slot. |
| 2 | `tower_light.png` | anchored to #1 | ~100×300, drawn twice, mirrored |
| 3 | `crowd_band.png` | anchored to #1 | ~400×100, repeated + mirrored across the frame |
| 4 | wall tileset | `create_sidescroller_tileset`, 32px | `lower`: padded outfield wall. `transition`: wall cap. ~25 tiles across the ground, with its own end tiles. |
| 5 | `walk_a/b/c.png` | anchored to #1 | one per Catwalk, at its exact width. Three distinct ones. |

Nine files. The asset route whitelists `^[a-z0-9]+_[a-z0-9]+\.png$`
(`brawl.js:802`), so these drop into `assets/brawl/` with **no route change**.

### Why a tileset for the wall and props for the Catwalks

The outfield wall is repeating terrain with two ends — exactly what
`create_sidescroller_tileset` exists for, edge tiles included. A Catwalk is a
manufactured object that needs visible ends and a bracket where it meets the
rig; tiling one 32px grating seven times gives a 220px run with no ends.
Generating three *different* Catwalks also does free work for orientation —
players learn "the high one" faster when it doesn't look like the other two.

### Rules the art must obey

- **No railings above a Catwalk's walking surface.** Anything drawn above the
  walk line reads as collision that isn't there, and on a drop-through platform
  that's actively misleading.
- **The scoreboard carries a flat, empty, dark slot** where a line score would
  go, placed high (above y≈200), out of the band where the Catwalks and most
  fighting live. v1 draws nothing into it. Wiring it to real data later — the
  Day Tally, today's KO leader — is then a code change against art that already
  accommodates it, instead of a regeneration.
- **The crowd is silhouettes**, rim-lit from above, never faces. At 1:1 scale a
  spectator is 10–20px tall; faces don't survive that and bright ones eat
  sprites. A handful of silhouettes get the *wrong shape* on purpose — a
  bottle-cap head, a long bun, a grill dome — because shape carries at 15px
  where detail doesn't. Same trick the Fighters use at 64px.
- **The Stage is static.** No ambient motion, no reactive crowd. A still Stage
  also means the preview PNG *is* the Stage, so the gate sees exactly what
  players see. KO drama stays with the sparks and the flourish layer.

## Style anchoring and order

`create_sidescroller_tileset` takes **no style image** — only `base_tile_id`
plus `outline`/`shading`/`detail` enums. So the wall can only be matched by
knobs and by comparison, which fixes the order:

1. **`board_main` first**, anchored to The Glizzy's `stand` with
   `style_copy: ["outline", "detail", "shading"]` — deliberately **excluding
   `color_palette`**. The roster's palette is hot-dog warm; a night ballpark
   needs blue, green and stadium amber. The one Fighter-anchored link at the top
   of the chain is enough to keep line weight and shading density in family.
2. **Towers, crowd, Catwalks** anchored to `board_main`, not to a Fighter — a
   character's rendering conventions aren't a building's, and the Stage needs
   to be internally consistent first.
3. **The tileset last**, so its enums are tuned against finished neighbours
   instead of guessed in a vacuum.

The scoreboard is both the style anchor and the piece most likely to need
re-rolls, which is why it goes first: its re-rolls are free, and re-rolling it
later would invalidate everything anchored to it.

## Code seam

**`brawl-stage.js`**, served to the browser at `/brawl/stage.js` — the same
pattern as `brawl-sim.js` and `brawl-art.js`, and for the same reason: one
file, no replica to drift. It exports the scene description (prop list with
positions, tile runs, draw order) and the draw function `brawl-page.js` calls.

`scripts/brawl-stage-preview.mjs` renders the empty Ballpark to a PNG from
*that same module*, so composition can be judged without a browser. This is not
optional decoration — composing props blind (the known cost of not painting one
image) means iterating on layout, and doing that through a live WebSocket game
page is miserable. The repo has already learned that a preview which disagrees
with the Arena is worse than none, which is the argument for the game and the
preview importing the same code.

**Placement stays in `brawl-stage.js` as readable coordinates**, never baked
into an import step — placement is the thing that gets iterated.

### Fallback

Per-surface, matching what the sprites already do (*"an asset 404 must never
blank the Arena"*): each surface draws its art if the image is in the cache,
else its current primitive. So the ground can go bespoke while the Catwalks are
still orange bars, and a bad deploy degrades instead of leaving invisible floors.

Backdrop props are the easy case — they layer over the sky gradient and have
nothing to hide, so a missing scoreboard just means sky.

### Import

`scripts/brawl-import-stage.mjs`, deliberately thin: de-background, trim to
alpha bounds, scale to a target on-screen size, write measured bounds into the
manifest. Nothing else. A prop has no feet to plant, no ten-pose set to scale
uniformly, and no `FRAME.width` apparent-size dial, so extending
`brawl-import-sprites.mjs` would give it a second personality.

De-backgrounding is the non-negotiable part — PixelLab returns art on
backgrounds, and `sharp.trim()` keys off the top-left pixel and returns the
full canvas on transparent art. Six props done by hand is how we get six
subtly different results.

## The gate

Eyes lie — the Fighter work proved it twice with a crouch at 89% of standing
height and a punch extending 3px. But the checks split by what they're checking,
because `test/brawl-art.test.js` is the repo's third and only extra seam and it
tests **pure functions only — no canvas, no images**. Widening that quietly
would be the wrong way to get stage coverage.

**At import time** (`scripts/brawl-import-stage.mjs`, which already decodes the
art and already has `sharp`), failing the import:

1. **Floor alignment.** The wall tileset's opaque top row lands exactly on
   `STAGE.ground.y`.
2. **Catwalk clearance.** Zero opaque pixels above each Catwalk's walk line.

**In the preview script**, reported and non-zero on failure:

3. **Silhouette contrast.** Composite each Fighter's `stand` over the backdrop
   at all 8 spawn points; require a minimum mean luminance delta along the
   silhouette.

(1) and (2) are bugs, not taste — a floating floor and a phantom railing are
each one bounding-box read away from being impossible. (3) earns its keep
because "night game, crowd behind the fight" is precisely the composition where
sprites get lost, and the crowd is generated blind to the Fighters. All three
are properties of *assets*, and assets change only at import, so that's where
they fail — at the moment the art is wrong, not on every `npm test`.

**In `test/brawl-stage.test.js`**, pure, no images: every prop the scene
references resolves to a known asset; every Catwalk in the scene matches a
`STAGE.platforms` entry; draw order is back-to-front; a missing asset selects
its primitive rather than drawing nothing. This is the check that guards the
one failure this feature can suffer silently — the scene drifting from the sim
when someone moves a platform.

**Derive (3)'s threshold, don't invent it**: measure the current placeholder
Stage, which is known-readable, and set the floor below what it scores. If the
new backdrop reads worse than a flat gradient behind a Fighter, that's a real
finding.

A busyness/variance ceiling was considered and dropped: it's a proxy for what
(3) measures directly, and a threshold we can't justify either never fires or
fires on art that's fine.

## As built

The plan survived contact. Five things it didn't predict, all now load-bearing:

- **Props are generated on a magenta chroma key, not `no_background`.** Two
  reasons, both discovered the hard way. An edge flood fill can never reach the
  background trapped inside a lattice truss's bracing, which is exactly what
  the scoreboard is made of — so the importer keys the colour out globally
  instead (`--key`, several shades at once, because the model dithers it). And
  `create_image_pro` with `no_background: true` stalled at 49% indefinitely on
  two separate jobs; with it off, the same prompt at the same size completed.
- **A third gate: scale.** A prop must land 1:1 or fail the import. The
  scoreboard arrived as 266×173 of content inside a 400×260 canvas, and the
  first import happily upscaled it 1.5× — losing, quietly, the exact property
  that composing from props exists to protect. The fix is never to rescale: it
  is to put the art's own size into `LAYOUT`, which the gate's error prints.
- **A wang tile's terrain boundary is its midline, not its edge.** The tileset
  is 16 wang tiles, so its cap tile is air above the midline and wall below it.
  The scene offsets the whole grid by half a tile in both axes; without that
  the walking surface sits 16px below the floor the sim collides against.
  Tiles are also copied verbatim — trimming one and stretching what's left
  doubles a cap tile's pixels and slides the wall face half a tile sideways.
- **The floor gate plants the surface, like feet.** The charcoal wall came back
  with its surface 2px below the midline. That is a floating floor, invisible
  in a screenshot, and it is the same problem the sprite importer already
  solves by planting feet on the floor line — so the cap is planted the same
  way, and the gate still fails anything it can't plant.
- **The clearance gate as specified would have rejected good art.** "Zero
  opaque pixels above the walk line" needs the walk line *found* rather than
  assumed: a grating is made of holes, and a deck's own 1px top bevel is not a
  railing. It now finds the first row that reads as a deck and fails on
  anything standing more than 2px clear of it.

Two calls worth revisiting, neither blocking:

- **The wall reads lighter than the rest of the Ballpark.** Three rolls, and
  `create_sidescroller_tileset` takes no style image — the risk this plan
  already named. The charcoal roll is the best of them and it is fine; it is
  not as dark as the ADR's "very dark" would ideally have it. One re-import
  away.
- **`walk_a` is thinner than the other two Catwalks.** A re-roll aimed at a
  thicker deck came back worse (a truss with gaps, no solid surface), so the
  original stands.

The silhouette-contrast gate lives in the preview script, not in
`test/brawl-stage.test.js` as [ADR 0003](adr/0003-the-stage-is-a-night-scene.md)
originally said; that ADR has been corrected. The placeholder Stage measures a
mean of 19.9 and a worst placement of 14.1, so the floor is 12. The finished
Ballpark measures 23.7 mean, nothing below the floor.

## Deliberately later

- **The live scoreboard.** Best idea in the design session and the one most
  likely to blow up the schedule: needs a font (`create_font`), per-glyph
  layout against art generated blind, a data decision, and it's the piece most
  in tension with readability. The slot ships in v1; the wiring doesn't.
- **Extra props** — bunting, foul pole, pennants, warning-track detail. Cheap
  to add later precisely because placement lives in readable coordinates. Add
  them once we've played on it and know what's missing.
- **Animation.** Generated frames look cheap next to good static art, and we
  won't know whether the Ballpark needs motion until it's been fought on.
- **A second Stage.** Nothing here assumes one, but nothing supports two yet
  either — `STAGE` is a single exported constant.
