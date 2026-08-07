// Import GlizzyClicker's PixelLab art into assets/clicker.
//
//   node scripts/clicker-import-art.mjs <staging-dir>
//   node scripts/clicker-import-art.mjs <staging-dir> --dry-run
//
// Staging files are named for what they are: `hero.png` / `golden.png`
// (120x90, the clickable mascot and its golden variant), `building_<id>.png`
// (40x40, one per BUILDINGS entry), `emoji_<name>.png` (32x32, one per emoji
// the game renders — EMOJI_NAMES below maps name to the emoji character).
//
// Deliberately thin, and it never resamples: every image must arrive at the
// exact size the game draws it, because the display scale is an integer
// multiple of the art (hero x3, icons x1) and any resample on the way in
// breaks the pixel grid silently. The fix for a wrong-size image is to
// regenerate it at the right size, not to let the importer stretch it.
//
// Gates (fail the import, not the game):
//   size    exact canvas match, per kind
//   alpha   all four corners transparent — PixelLab sometimes returns a filled
//           background, which would ship as an opaque square on the dark page
//   content opaque bounding box covers >=20% of the canvas — an empty or
//           near-empty PNG is a generation that silently failed
//
// The manifest maps logical keys to filenames; game.js reads it at boot and
// falls back per surface (hero -> HERO_SVG, building -> BUILDING_SVGS entry,
// emoji -> the raw character) for anything missing. Deleting a PNG and its
// manifest line reverts that one surface to the hand-drawn art.

import { loadImage } from "@napi-rs/canvas";
import { contentBounds, toCanvas } from "./lib/pixel-art.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "assets", "clicker");
const MANIFEST = path.join(ART_DIR, "manifest.json");

// Mirrors BUILDINGS in glizzy.js (not imported: glizzy.js pulls in database.js,
// which opens the production SQLite path at import time).
const BUILDING_IDS = new Set([
  "mustard_stand", "bun_factory", "glizzy_cart", "food_truck", "stadium",
  "franchise", "orbital_station", "glizzy_megaplex", "quantum_kitchen",
  "dyson_grill", "black_hole_bun", "multiverse_glizzy",
]);

// Icon name -> the emoji character it replaces wherever the game renders one.
// Building emojis point at `mini_*` icons (32px cousins of the 40px building
// art) because the 40px originals don't sit on the 32px pixel grid.
export const EMOJI_NAMES = {
  knife: "🔪", mustard: "🟡", wheat: "🌾", bag: "🛍️", racecar: "🏎️",
  briefcase: "💼", bolt: "⚡", handshake: "🤝", tomato: "🍅", church: "⛪",
  chart: "📈", rocket: "🚀", medal: "🥇", gear: "⚙️", link: "🔗",
  salt: "🧂", pickle: "🥒", onion: "🧅", cabbage: "🥬", bacon: "🥓",
  cheese: "🧀", chili: "🌶️", salad: "🥗", book: "📖", star: "⭐",
  globe: "🌍", crown: "👑", infinity: "♾️", flag: "🏁",
  tongs: "🥢", fencer: "🤺", droplet: "💧", fist: "✊", point: "☝️",
  hand: "🖐️", palms: "🤲", chef: "🧑‍🍳",
  clover: "🍀", slots: "🎰", rainbow: "🌈", shamrock: "☘️",
  plate: "🍽️", sunrise: "🌅", owl: "🦉", flame: "🔥", hundred: "💯",
  trophy: "🏆", comet: "🌠", demon: "😈", moneybag: "💰", tap: "👆",
  oracle: "🔮", hourglass: "⏳", poof: "💨", sparkles: "✨", hotdog: "🌭",
  mini_bun_factory: "🍞", mini_glizzy_cart: "🛒", mini_food_truck: "🚚",
  mini_stadium: "🏟️", mini_franchise: "🏪", mini_orbital_station: "🛰️",
  mini_glizzy_megaplex: "🏢", mini_quantum_kitchen: "⚛️",
  mini_dyson_grill: "☀️", mini_black_hole_bun: "🕳️",
  mini_multiverse_glizzy: "🌌",
};

const SIZES = {
  hero: [120, 90],
  golden: [120, 90],
  building: [40, 40],
  emoji: [32, 32],
};

function classify(name) {
  if (name === "hero" || name === "golden") return { kind: name, key: name };
  if (name.startsWith("building_")) {
    const id = name.slice("building_".length);
    if (!BUILDING_IDS.has(id)) throw new Error(`${name}: no such building id`);
    return { kind: "building", key: id };
  }
  if (name.startsWith("emoji_")) {
    const icon = name.slice("emoji_".length);
    if (!EMOJI_NAMES[icon]) throw new Error(`${name}: not in EMOJI_NAMES — add it there first`);
    return { kind: "emoji", key: EMOJI_NAMES[icon] };
  }
  throw new Error(`${name}: unrecognized staging name`);
}

async function gate(file, kind) {
  const img = await loadImage(file);
  const [w, h] = SIZES[kind];
  if (img.width !== w || img.height !== h) {
    throw new Error(`${path.basename(file)}: ${img.width}x${img.height}, needs exactly ${w}x${h} — regenerate, don't resample`);
  }
  const canvas = toCanvas(img);
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    if (data[(y * w + x) * 4 + 3] !== 0) {
      throw new Error(`${path.basename(file)}: corner (${x},${y}) is opaque — background didn't come off`);
    }
  }
  const bounds = contentBounds(canvas);
  if (!bounds || (bounds.width * bounds.height) < 0.2 * w * h) {
    throw new Error(`${path.basename(file)}: content covers ${bounds ? Math.round((100 * bounds.width * bounds.height) / (w * h)) : 0}% of the canvas — generation likely failed`);
  }
}

const [, , stagingDir, flag] = process.argv;
if (!stagingDir) {
  console.error("usage: node scripts/clicker-import-art.mjs <staging-dir> [--dry-run]");
  process.exit(1);
}
const dryRun = flag === "--dry-run";

const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith(".png"));
const manifest = { hero: null, golden: null, buildings: {}, emoji: {} };
const errors = [];

for (const f of files.sort()) {
  const name = f.slice(0, -4);
  try {
    const { kind, key } = classify(name);
    await gate(path.join(stagingDir, f), kind);
    if (kind === "hero" || kind === "golden") manifest[kind] = f;
    else if (kind === "building") manifest.buildings[key] = f;
    else manifest.emoji[key] = f;
  } catch (err) {
    errors.push(err.message);
  }
}

if (errors.length) {
  console.error(`REFUSED — ${errors.length} file(s) failed their gate:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const missing = Object.entries(EMOJI_NAMES).filter(([n]) => !files.includes(`emoji_${n}.png`));
for (const [n, e] of missing) console.warn(`note: no emoji_${n}.png staged — ${e} will render as the raw character`);

const count = `${manifest.hero ? 1 : 0} hero, ${manifest.golden ? 1 : 0} golden, ` +
  `${Object.keys(manifest.buildings).length} buildings, ${Object.keys(manifest.emoji).length} emoji icons`;
if (dryRun) {
  console.log(`dry run OK: ${count}`);
  process.exit(0);
}

fs.mkdirSync(ART_DIR, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(stagingDir, f), path.join(ART_DIR, f));
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`imported ${count} -> ${path.relative(ROOT, ART_DIR)}`);
