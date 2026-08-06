# GlizzyClicker pixel art

Everything the game page draws that used to be a hand-drawn SVG or an emoji now
has a PixelLab-generated pixel PNG in `assets/clicker/`, wired through
`manifest.json`. The SVGs and emoji are still in the code as per-surface
fallbacks — delete a PNG (and its manifest line) and that one surface reverts,
nothing else notices.

## What exists

| Kind | Size | Drawn at | Files |
|---|---|---|---|
| Hero (the clickable glizzy) | 120×90 | 360px wide (×3) | `hero.png` |
| Golden glizzy | 120×90 | 240px wide (×2) | `golden.png` |
| Building icons | 40×40 | 40px (×1) | `building_<id>.png`, one per `BUILDINGS` entry |
| Emoji icons | 32×32 | 32px (×1) or 16px (÷2) | `emoji_<name>.png`, one per emoji the game renders |

The display size is always an integer multiple of the art (with
`image-rendering: pixelated` via the `.px-art` class), which is why the
importer refuses to resample: a wrong-size PNG means regenerate, not stretch.

Emoji icons cover every emoji in `glizzy.js` (upgrades, bonuses, golden
rewards) plus the UI's own (🔮 🏆 ⏳ 💨 ✨ 🌭). Building emojis (🍞 🛒 …) map to
`emoji_mini_<building>.png` — 32px cousins of the 40px building art, generated
separately because the 40px originals don't sit on the 32px pixel grid. 🌭 is
also the favicon. The emoji-character ↔ icon-name table is `EMOJI_NAMES` in
`scripts/clicker-import-art.mjs`; the manifest maps the emoji *character* to a
file, and `game.js` (server) / `eIcon()` (client) render an `<img>` when the
map has one and the raw character when it doesn't.

Icon `<img>` sizes must stay on the integer grid: 32 (1:1) or 16 (2:1).
Anything else shears the pixels unevenly — visibly.

## Regenerating art

PixelLab access (the same account that made the GlizzyBrawl art):

- REST v1 (`https://api.pixellab.ai/v1`, bearer token from the `pixellab`
  MCP server config): `generate-image-pixflux` is synchronous, 1 generation
  per call, and fine for 32×32 icons. `init_image` + `init_image_strength`
  (~300 = subtle, ~150 = real edit) reuses an existing design — the `mini_*`
  icons were seeded from their 40×40 building art this way.
- The MCP server's `create_image_pro` (async job, ~20 generations) is what the
  hero and buildings came from. At ≤42px it generates **64 candidates** but
  the job result only inlines 4 — the rest are at
  `https://api.pixellab.ai/mcp/images/<job_id>/download?index=0..63`, no auth.
  Fetch them all and pick; the spread is worth it.
- Ask for transparent backgrounds (`no_background`) and gate on the corners
  anyway. Concurrent MCP jobs cap at 8 per account.
- The golden glizzy is **not generated**: img2img kept the sausage red at every
  strength worth keeping the face at. It's a programmatic hue-remap of
  `hero.png` into the gold band (keep near-white and near-black pixels, shift
  everything else to hue ≈0.115), so it stays pixel-identical in silhouette.
  If the hero changes, re-run the remap, not a prompt.

## Importing

```
node scripts/clicker-import-art.mjs <staging-dir> [--dry-run]
```

Staging names say what things are (`hero.png`, `building_<id>.png`,
`emoji_<name>.png`); the importer classifies by name, gates (exact size,
transparent corners, content ≥20% of canvas), copies verbatim, and rewrites
`manifest.json`. A new emoji icon needs its character added to `EMOJI_NAMES`
first — the importer refuses names it doesn't know.

Art gates live in the importer, not `npm test`, same reasoning as the
GlizzyBrawl stage: a bad asset can only arrive via an import, so that's where
it should fail. A *missing* asset isn't a failure at all — it's the fallback
working as designed.
