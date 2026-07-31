# GlizzyBrawl — Fighter art brief

What to hand an image generator, and how to get the result into the game.

The Arena treats art as swappable: `assets/brawl/manifest.json` records which
Fighters have art of their own, and those stop getting a costume drawn over a
borrowed body. So you can do **one Fighter at a time** — import The Glizzy,
play it, and the other three keep their current look until you're happy.

## The four Fighters

| Fighter | What it is | Frame stats it should look like |
|---|---|---|
| **The Glizzy** | A hot dog in a bun — the everyman | Balanced, middleweight, friendly |
| **Ketchup** | A ketchup bottle | Fast and light; lean, top-heavy, twitchy |
| **The Grill** | A charcoal grill | Slow heavyweight; wide, heavy, planted |
| **Corn Dog** | A corn dog on a stick | Long reach; tall and thin, the stick reads as a weapon |

The food *is* the character — arms and legs on the food itself, not a person
holding food or wearing a costume. That last one is what we tried and it
didn't work.

## The ten poses

Generate these, in this order if you're making a sheet:

```
stand   walk1   walk2   jump   fall
duck    hurt    action1 kick   action2
```

- `walk1` / `walk2` — two contact poses of a run, opposite legs forward
- `jump` — rising, legs tucked; `fall` — descending, arms up
- `duck` — crouched, clearly shorter than `stand`
- `hurt` — knocked back, head snapped away, arms flung
- `action1` — a quick jab (light attack)
- `kick` — a big committed swing or kick (heavy attack)
- `action2` — the signature move, most dramatic pose of the set:
  Glizzy lunges forward biting · Ketchup squeezes a splat ·
  Grill flares up with flame · Corn Dog stabs downward with the stick

## Prompt shape

Something like this, one Fighter at a time:

> 16-bit pixel art sprite sheet of a cartoon hot dog character, a frankfurter
> in a bun with arms and legs and a friendly face, side view facing right, full
> body, chunky dark outline, limited palette, flat white background, 5 columns
> by 2 rows, same character in every cell, poses in order: standing, running
> step 1, running step 2, jumping, falling, crouching, being knocked back,
> quick punch, big kick, dramatic lunge attack

Then swap the subject line for the others:

- `a cartoon ketchup bottle character, red glass bottle with a cap for a head`
- `a cartoon charcoal grill character, squat black kettle grill with glowing coals`
- `a cartoon corn dog character, battered sausage on a wooden stick`

**Things worth putting in the prompt**, learned from the art already in here:

- **Side view, facing right.** The renderer mirrors for facing; a three-quarter
  view mirrors badly.
- **Flat, plain background** (white or magenta). The importer floods the
  background out from the edges, so a plain one is far more reliable than a
  "transparent" checkerboard, which models often draw *as squares*.
- **Chunky outline, limited palette.** Both make the sprite read at 64px. Thin
  detail disappears at Arena scale.
- **Whole body in frame, feet visible** in every cell.
- Avoid a red-versus-green pairing to distinguish anything — the owner is
  colorblind. The site's palette is dark slate with `#ff6b35` orange, and the
  Arena uses plasma tones (purple → magenta → orange) everywhere else.

Consistency across cells is the usual failure. If the model drifts, generate
each pose separately from the same seed/reference and use the folder import
below.

## Getting it into the game

**From one sheet:**

```bash
node scripts/brawl-import-sprites.mjs glizzy ~/Downloads/glizzy-sheet.png --grid 5x2
```

**From a folder of one-pose-per-file** (named `stand.png`, `walk1.png`, …):

```bash
node scripts/brawl-import-sprites.mjs ketchup ~/Downloads/ketchup-poses/
```

Useful flags: `--bg "#ffffff"` to name the background colour explicitly,
`--tolerance 60` if the background is gradient-ish and bits of it survive,
`--keep-bg` if the art already has real transparency, `--dry-run` to see what
it would do, `--poses stand,walk1` if you only made some.

The importer removes the background, trims, scales **every frame by the same
factor** (so a duck stays shorter than a stand), stands each frame on the floor
line, and writes `assets/brawl/<fighter>_<pose>.png` at 64×72. Then it adds the
Fighter to `manifest.json`, which is what tells the game to stop drawing a
costume over it.

Reload `/brawl` — no restart needed, the manifest is re-read per request.

## Checking it

```bash
node scripts/brawl-art-preview.mjs        # writes brawl-roster.png
```

Renders every Fighter in every pose through the same code the Arena uses, so
what you see is what the game draws. Worth a look before playing: it's how the
last two art passes got caught.

## If you'd rather not generate anything

`scripts/brawl-make-sprites.mjs` builds a pixel-art prototype set from ASCII
rigs in the repo (`assets/brawl/pixel/`). It's rough — stubby limbs — but it's
a working example of the bespoke path, and importable:

```bash
node scripts/brawl-make-sprites.mjs
node scripts/brawl-import-sprites.mjs glizzy assets/brawl/pixel/ --keep-bg
```
