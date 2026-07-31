// Import the Ballpark's props into GlizzyBrawl.
//
//   node scripts/brawl-import-stage.mjs <prop> <image.png>
//   node scripts/brawl-import-stage.mjs --list
//
// Deliberately thin: knock out the background, trim to alpha bounds, scale to
// the size the scene draws the prop at, gate the two things eyes get wrong, and
// record the result in the manifest. Nothing else.
//
// It is a separate script from `brawl-import-sprites.mjs` on purpose. A prop has
// no feet to plant, no ten-pose set to scale by a shared factor, and no
// apparent-size dial — folding it into the sprite importer would give that
// script a second personality rather than reusing anything.
//
// De-backgrounding is the non-negotiable part. PixelLab returns art on
// backgrounds, and `sharp.trim()`-style corner tricks return the full canvas on
// art that already has alpha, so every prop has to go through the same flood
// fill or six props come out six subtly different ways. That flood fill, and
// the bounding box it feeds, are shared with the sprite importer in
// `lib/pixel-art.mjs` — two copies of them had already drifted.
//
// Options:
//   --key "#c2308f"  chroma-key colour to remove everywhere (props are generated
//                    on magenta; a lattice truss traps background inside its
//                    bracing, where an edge flood fill can never reach it)
//   --bg "#0b1220"   background colour to flood-remove from the edges inward
//   --tolerance 40   how close a pixel must be to count as background (0-255)
//   --keep-bg        don't remove any background (art already has alpha)
//   --anchor top|bottom|center   where trimmed art sits in its frame
//   --dry-run        report what it would write, write nothing

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { contentBounds, keyOutColor, removeBackground, toCanvas } from "./lib/pixel-art.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE } from "../brawl-sim.js";
import { CATWALK_ART, LAYOUT, TILE, buildScene } from "../brawl-stage.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "assets", "brawl");
const MANIFEST = path.join(ART_DIR, "manifest.json");

const scene = buildScene(STAGE);
const catwalkOf = (name) => scene.pieces.find((p) => p.assets[0] === name && p.kind === "catwalk");

/**
 * What each prop is imported as. `width`/`height` come from the scene, so the
 * art is always cut to the size the Arena actually draws it at — a prop and its
 * placement can't disagree about size, because only one of them states it.
 *
 * `anchor` is where trimmed content sits once it's scaled to fit: a Catwalk's
 * walking surface is the *top* of its art, a tower stands on its base.
 */
function targets() {
  const out = {
    board_main: { ...size(LAYOUT.board), anchor: "center" },
    tower_light: { ...size(LAYOUT.towers[0]), anchor: "bottom" },
    crowd_band: { width: LAYOUT.crowd.width, height: LAYOUT.crowd.height, anchor: "bottom" },
    wall_cap: { width: TILE, height: TILE, tile: true, gate: "floor" },
    wall_lower: { width: TILE, height: TILE, tile: true },
    wall_end: { width: TILE, height: TILE, tile: true },
  };
  for (const name of CATWALK_ART) {
    const piece = catwalkOf(name);
    out[name] = { width: piece.art.width, height: piece.art.height, anchor: "top", span: true, gate: "clearance" };
  }
  return out;
}

const size = (r) => ({ width: r.width, height: r.height });
const TARGETS = targets();

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["bg", "key", "tolerance", "anchor"]);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) { positional.push(arg); continue; }
  const name = arg.slice(2);
  if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
  else flags[name] = true;
}
const flag = (name, fallback = null) => (name in flags ? flags[name] : fallback);
const has = (name) => flags[name] === true;

if (has("list")) {
  for (const [name, t] of Object.entries(TARGETS)) {
    console.log(`  ${name.padEnd(12)} ${t.width}x${t.height}${t.tile ? "  (tile)" : ""}${t.gate ? `  gate: ${t.gate}` : ""}`);
  }
  process.exit(0);
}

const [prop, source] = positional;
if (!prop || !source) {
  console.error("usage: brawl-import-stage.mjs <prop> <image.png>   (--list for props)");
  process.exit(1);
}
const target = TARGETS[prop];
if (!target) {
  console.error(`unknown prop "${prop}" — expected one of ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const tolerance = Number(flag("tolerance", 40));
const anchor = flag("anchor", target.anchor || "center");
const dryRun = has("dry-run");

// -------------------------------------------------------------- image ops
//
// De-background, measure, cut. All three are shared with the sprite importer.

/** Fraction of a row that is opaque. */
function rowOpacity(canvas, y) {
  const { width: w } = canvas;
  const data = canvas.getContext("2d").getImageData(0, y, w, 1).data;
  let solid = 0;
  for (let x = 0; x < w; x++) if (data[x * 4 + 3] >= 128) solid += 1;
  return solid / w;
}

/** Opaque pixels in a row. */
function rowPixels(canvas, y) {
  return Math.round(rowOpacity(canvas, y) * canvas.width);
}

/**
 * Scale trimmed content into the frame the scene draws it at.
 *
 * A tile fills its frame edge to edge — the wall repeats, and a tile with a
 * transparent margin is a seam.
 *
 * A Catwalk *spans*: it is scaled by width alone, because it represents a
 * surface and art that stops short of the platform's end is art that lies about
 * where you can stand. Fitting it inside the frame instead would let a prop
 * whose aspect is a little off draw narrower than the thing it stands for.
 *
 * Everything else keeps its aspect and is placed by its anchor.
 */
function fit(canvas, bounds) {
  const out = createCanvas(target.width, target.height);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  if (target.tile) {
    // A tile is taken verbatim: the cell *is* the tile, and where its content
    // sits inside the cell is the tileset's whole convention for which side is
    // ground. Trimming it and stretching the remainder to fill — which is what
    // this used to do — doubles the pixels of a cap tile and slides the wall
    // face half a tile sideways, both silently.
    ctx.drawImage(canvas, 0, 0);
    return target.gate === "floor" ? plantSurface(out) : out;
  }
  const scale = target.span
    ? target.width / bounds.width
    : Math.min(target.width / bounds.width, target.height / bounds.height);
  const w = Math.max(1, Math.round(bounds.width * scale));
  const h = Math.max(1, Math.round(bounds.height * scale));
  const dx = Math.round((target.width - w) / 2);
  const dy = anchor === "top" ? 0 : anchor === "bottom" ? target.height - h : Math.round((target.height - h) / 2);
  ctx.drawImage(canvas, bounds.x1, bounds.y1, bounds.width, bounds.height, dx, dy, w, h);
  return out;
}

/**
 * Slide a cap tile so its walking surface lands on the tile's midline.
 *
 * This is the Stage's version of planting a Fighter's feet on the floor line,
 * and it exists for the same reason: a generator gets it right to within a
 * pixel or two, and a pixel or two is a floating floor. The charcoal wall came
 * back with its surface 2px below the midline — invisible in a screenshot,
 * clearly wrong the moment a Fighter stands on it.
 *
 * The rows vacated at the bottom are filled by repeating the tile's own last
 * row, so sliding the surface up never opens a transparent seam between the cap
 * and the wall below it. The floor gate still runs afterwards: if there is no
 * solid surface to plant at all, nothing here can invent one.
 */
function plantSurface(canvas) {
  const midline = canvas.height / 2;
  let surface = -1;
  for (let y = 0; y < canvas.height; y++) {
    if (rowOpacity(canvas, y) >= 0.95) { surface = y; break; }
  }
  if (surface < 0 || surface === midline) return canvas;

  const shift = midline - surface;
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, shift);
  if (shift < 0) {
    // Slid down: repeat the source's top row into the gap it left above.
    for (let y = 0; y < -shift; y++) ctx.drawImage(canvas, 0, 0, canvas.width, 1, 0, y, canvas.width, 1);
  } else {
    const last = canvas.height - 1;
    for (let y = canvas.height - shift; y < canvas.height; y++) {
      ctx.drawImage(canvas, 0, last, canvas.width, 1, 0, y, canvas.width, 1);
    }
  }
  console.log(`planted the cap's surface on the midline (${shift > 0 ? "+" : ""}${shift}px)`);
  return out;
}

// ------------------------------------------------------------- the gates
//
// Both of these are bugs, not taste, and both are one bounding-box read away
// from being impossible. The Fighter work proved twice that eyes miss them: a
// "crouch" at 89% of standing height and a "punch" extending 3px both passed a
// visual check. They fail the import because they are properties of the asset,
// and an asset only changes here.

/** Rows of the deck's own edge detail tolerated above a Catwalk's walk line. */
const MAX_ABOVE_WALK_LINE = 2;

const GATES = {
  /**
   * Scale: a prop is drawn at 1:1, like everything else on this canvas.
   *
   * A Fighter's art is one art pixel to one canvas pixel, and the whole reason
   * the Ballpark is composed from props instead of painted as one image is that
   * every way of upscaling a 400×400 backdrop to 1280×720 gives pixels visibly
   * chunkier than the roster's. Resampling a prop on the way in loses that by
   * the back door, quietly.
   *
   * The fix is never to rescale here — it is to put the art's own size into
   * `LAYOUT` in `brawl-stage.js`, where placement lives and is meant to be
   * iterated. So this gate hands you the number to paste.
   */
  scale(canvas, bounds) {
    if (target.tile || target.span) return null; // both resample on purpose
    const factor = Math.min(target.width / bounds.width, target.height / bounds.height);
    if (Math.abs(factor - 1) <= 0.02) return null;
    return `the art is ${bounds.width}x${bounds.height} but the scene draws ${prop} at ${target.width}x${target.height} — a ${factor.toFixed(2)}x resample.\n` +
      `  Set LAYOUT.${prop === "board_main" ? "board" : prop === "crowd_band" ? "crowd" : "towers[…]"} in brawl-stage.js to ${bounds.width}x${bounds.height}, or pass --rescale if you mean it.`;
  },

  /**
   * Floor alignment: the wall's cap tile is what Fighters stand on, and the
   * scene puts its top row exactly on `STAGE.ground.y`. A cap whose art starts
   * a few pixels down is a floating floor — Fighters stand on nothing.
   */
  floor(canvas) {
    let surface = -1;
    for (let y = 0; y < canvas.height; y++) {
      if (rowOpacity(canvas, y) >= 0.95) { surface = y; break; }
    }
    const midline = canvas.height / 2;
    if (surface < 0) return `no solid row anywhere in the cap tile — the floor line at y=${STAGE.ground.y} needs a surface Fighters can stand on`;
    if (Math.abs(surface - midline) <= 1) return null;
    return `the cap's surface is row ${surface}, but a wang tile's terrain boundary is its midline (row ${midline}) — the scene offsets the grid by half a tile to put that boundary on y=${STAGE.ground.y}, so this wall would sit ${Math.round(surface - midline)}px off the floor line`;
  },

  /**
   * Catwalk clearance: zero opaque pixels above the walk line.
   *
   * The walk line is found in the art rather than assumed, because "is the top
   * row solid?" is a different question and gets the wrong answer twice: a
   * grating is *made* of holes, and a prop whose art is narrower than its frame
   * can't fill a row at all. So: find the first row that reads as a deck, then
   * require nothing at all above it. A railing or a post in the source lands
   * above the walking surface and reads as collision that isn't there — on a
   * drop-through platform, actively misleading.
   */
  clearance(canvas) {
    let deck = -1;
    for (let y = 0; y < canvas.height; y++) {
      if (rowOpacity(canvas, y) >= 0.6) { deck = y; break; }
    }
    if (deck < 0) return "no solid walking surface anywhere in the art — a Catwalk needs a deck Fighters can stand on";
    // A deck's own top edge — a highlight, a lip, a row of anti-aliased pixels —
    // is not a railing, and holding out for a literal zero rejects good art on a
    // one-pixel bevel. What a railing actually is, is *tall*: posts and a rail
    // stand several pixels clear of the surface.
    if (deck <= MAX_ABOVE_WALK_LINE) return null;
    let above = 0;
    for (let y = 0; y < deck; y++) above += rowPixels(canvas, y);
    return `the walking surface starts ${deck}px down, with ${above} opaque pixels above it; a railing or post there reads as collision that isn't there — regenerate without it`;
  },
};

// ------------------------------------------------------------------- main

const img = await loadImage(source);
const raw = toCanvas(img);
const cleaned = has("keep-bg") ? raw
  : flag("key") ? keyOutColor(raw, flag("key"), tolerance)
  : removeBackground(raw, flag("bg"), tolerance);
const bounds = contentBounds(cleaned);
if (!bounds) {
  console.error("nothing survived the background removal — try --bg or --tolerance");
  process.exit(1);
}
const fitted = fit(cleaned, bounds);

// Every prop is gated on scale; the surfaces are gated on the two ways a
// surface lies about where you can stand.
const gates = [has("rescale") ? null : "scale", target.gate].filter(Boolean);
for (const name of gates) {
  const failure = GATES[name](fitted, bounds);
  if (failure) {
    console.error(`${prop} fails the ${name} gate:`);
    console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`${prop} passes the ${name} gate.`);
}

let manifest = {};
if (fs.existsSync(MANIFEST)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
  catch { console.warn("manifest.json was unreadable; rewriting it"); }
}
manifest.stage = {
  ...(manifest.stage || {}),
  [prop]: { width: target.width, height: target.height, source: bounds },
};

const file = path.join(ART_DIR, `${prop}.png`);
if (!dryRun) {
  fs.writeFileSync(file, fitted.toBuffer("image/png"));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}
console.log(`${dryRun ? "[dry run] would write" : "wrote"} ${path.relative(ROOT, file)} — ${target.width}x${target.height} from ${bounds.width}x${bounds.height}`);
